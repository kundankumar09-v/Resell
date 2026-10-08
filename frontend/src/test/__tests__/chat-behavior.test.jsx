import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act, waitFor } from '@testing-library/react';
// test-utils must be imported BEFORE the components: its vi.mock context
// registrations apply to modules loaded after it.
import { renderWithProviders, mockSocketValue } from '../test-utils';
import Chat from '../../pages/Chat';

const { handlers, socketFns, toastFns } = vi.hoisted(() => ({
  handlers: {},
  socketFns: {
    emitTyping: vi.fn(),
    emitStopTyping: vi.fn(),
    setUnread: vi.fn(),
    clearUnread: vi.fn(),
    joinConversation: vi.fn(),
    leaveConversation: vi.fn(),
  },
  toastFns: { error: vi.fn(), success: vi.fn() },
}));

const { chatMocks } = vi.hoisted(() => ({
  chatMocks: {
    conversations: vi.fn(),
    messages: vi.fn(),
    send: vi.fn(),
    markRead: vi.fn(),
    createConversation: vi.fn(),
  },
}));

vi.mock('../../services/services', () => ({
  chatService: chatMocks,
  productService: { list: vi.fn(), get: vi.fn(), similar: vi.fn(), brands: vi.fn() },
  categoryService: { list: vi.fn() },
  favoriteService: { check: vi.fn(), add: vi.fn(), remove: vi.fn() },
  sellerService: { trust: vi.fn() },
  reportService: { create: vi.fn() },
  offerService: { create: vi.fn() },
  notificationService: { list: vi.fn(), unread: vi.fn(), markRead: vi.fn(), markAllRead: vi.fn() },
}));

vi.mock('react-hot-toast', () => ({ default: toastFns }));

const { routerMocks } = vi.hoisted(() => ({
  routerMocks: { params: {}, navigate: vi.fn() },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => routerMocks.params,
    useNavigate: () => routerMocks.navigate,
  };
});

const ME = { _id: 'user-me-1', name: 'Me' };
const OTHER = { _id: 'user-other-1', name: 'Other User' };
const CONV_ID = '111111111111111111111111';

// Socket handlers are captured so tests can dispatch socket events.
const socketValue = {
  socket: { id: 'sock' },
  on: (event, cb) => {
    handlers[event] = cb;
  },
  off: (event, cb) => {
    delete handlers[event];
  },
  ...socketFns,
};

const msg = (id, sender, content, extra = {}) => ({
  _id: id,
  conversation: CONV_ID,
  sender,
  content,
  createdAt: new Date().toISOString(),
  status: 'sent',
  readBy: [],
  ...extra,
});

describe('Chat — send, mark-read, read receipts and scroll behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(handlers).forEach((k) => delete handlers[k]);
    routerMocks.params = { id: CONV_ID };
    routerMocks.navigate.mockClear();
    chatMocks.conversations.mockResolvedValue({
      data: {
        conversations: [
          {
            _id: CONV_ID,
            participants: [ME, OTHER],
            product: null,
            lastMessage: null,
            lastMessageAt: new Date().toISOString(),
            unreadCounts: {},
          },
        ],
      },
    });
    chatMocks.messages.mockResolvedValue({ data: { messages: [] } });
    chatMocks.send.mockResolvedValue({ data: { message: msg('msg-1', ME, 'hello world') } });
    chatMocks.markRead.mockResolvedValue({ data: {} });
  });

  const renderChat = () =>
    renderWithProviders(<Chat />, { authValue: { user: ME }, socketValue });

  it('sends via REST, appends the message, clears the input and stops typing', async () => {
    const { getByPlaceholderText, findByText, findByPlaceholderText, findAllByText } = renderChat();

    await findByPlaceholderText('Type a message...');

    const input = getByPlaceholderText('Type a message...');
    fireEvent.change(input, { target: { value: 'hello world' } });
    fireEvent.submit(input.closest('form'));

    // The text appears in both the message bubble and the sidebar preview
    const found = await findAllByText('hello world');
    expect(found.length).toBeGreaterThanOrEqual(1);

    expect(chatMocks.send).toHaveBeenCalledWith({
      conversationId: CONV_ID,
      content: 'hello world',
    });
    expect(input.value).toBe('');
    expect(socketFns.emitStopTyping).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONV_ID, recipientId: OTHER._id })
    );
  });

  it('restores the input text when the send fails', async () => {
    chatMocks.send.mockRejectedValue({
      response: { status: 500, data: { message: 'Server error' } },
    });
    const { getByPlaceholderText, findByText, findByPlaceholderText, findAllByText } = renderChat();

    await findByPlaceholderText('Type a message...');

    const input = getByPlaceholderText('Type a message...');
    fireEvent.change(input, { target: { value: 'do not lose me' } });
    fireEvent.submit(input.closest('form'));

    await waitFor(() => expect(toastFns.error).toHaveBeenCalled());
    expect(input.value).toBe('do not lose me');
  });

  it('marks the conversation as read on load (REST + socket) and clears the badge', async () => {
    const { findByText, findByPlaceholderText } = renderChat();

    await findByPlaceholderText('Type a message...');

    await waitFor(() => expect(chatMocks.markRead).toHaveBeenCalledWith(CONV_ID));
    expect(socketFns.clearUnread).toHaveBeenCalledWith(CONV_ID);
    expect(mockSocketValue.emit).toHaveBeenCalledWith('chat:read', { conversationId: CONV_ID });
    expect(socketFns.joinConversation).toHaveBeenCalledWith(CONV_ID);
  });

  it('applies read receipts from other participants to my messages', async () => {
    chatMocks.messages.mockResolvedValue({
      data: { messages: [msg('msg-mine', ME, 'my message')] },
    });
    const { findByText, container } = renderChat();

    await findByText('my message');
    // No read receipt yet
    expect(container.querySelector('.text-blue-300')).toBeNull();

    act(() => {
      handlers['conversation:read']({ conversationId: CONV_ID, readerId: OTHER._id });
    });

    // The message is now marked read (blue double-check icon)
    expect(container.querySelector('.text-blue-300')).not.toBeNull();
  });

  it('does not apply read receipts for my own reads or other conversations', async () => {
    chatMocks.messages.mockResolvedValue({
      data: { messages: [msg('msg-mine', ME, 'my message')] },
    });
    const { findByText, container } = renderChat();

    await findByText('my message');

    act(() => {
      handlers['conversation:read']({ conversationId: CONV_ID, readerId: ME._id });
      handlers['conversation:read']({ conversationId: '222222222222222222222222', readerId: OTHER._id });
    });

    expect(container.querySelector('.text-blue-300')).toBeNull();
  });

  it('follows incoming messages only when already near the bottom, scrolling only the message container', async () => {
    chatMocks.messages.mockResolvedValue({
      data: { messages: [msg('m1', OTHER, 'old message')] },
    });
    const { findByText, findByText: _f, container } = renderChat();

    await findByText('old message');

    const messagesEl = container.querySelector('.chat-messages');
    Object.defineProperty(messagesEl, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(messagesEl, 'clientHeight', { value: 420, configurable: true });
    messagesEl.scrollTop = 0;

    // Reader is near the bottom (500 - 0 - 420 = 80 < 96) -> auto-follow armed
    fireEvent.scroll(messagesEl);

    // Incoming message arrives
    act(() => {
      handlers['chat:message'](msg('m2', OTHER, 'new message'));
    });

    // Only the internal container was scrolled to the bottom (never the window)
    await waitFor(() => expect(messagesEl.scrollTop).toBe(500));
  });

  it('does not auto-scroll when the reader is away from the bottom', async () => {
    chatMocks.messages.mockResolvedValue({
      data: { messages: [msg('m1', OTHER, 'old message')] },
    });
    const { findByText, container } = renderChat();

    await findByText('old message');

    const messagesEl = container.querySelector('.chat-messages');
    Object.defineProperty(messagesEl, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(messagesEl, 'clientHeight', { value: 100, configurable: true });
    messagesEl.scrollTop = 0;

    // Reader is far from the bottom (500 - 0 - 100 = 400 >= 96) -> no follow
    fireEvent.scroll(messagesEl);

    act(() => {
      handlers['chat:message'](msg('m2', OTHER, 'new message'));
    });

    expect(messagesEl.scrollTop).toBe(0);
  });

  it('smooth-scrolls to the bottom when sending a message', async () => {
    chatMocks.send.mockResolvedValue({ data: { message: msg('msg-2', ME, 'hi there') } });
    const { getByPlaceholderText, findByText, findByPlaceholderText, findAllByText, container } = renderChat();

    await findByPlaceholderText('Type a message...');

    const messagesEl = container.querySelector('.chat-messages');
    Object.defineProperty(messagesEl, 'scrollHeight', { value: 500, configurable: true });
    const scrollSpy = vi.fn();
    messagesEl.scrollTo = scrollSpy;

    const input = getByPlaceholderText('Type a message...');
    fireEvent.change(input, { target: { value: 'hi there' } });
    fireEvent.submit(input.closest('form'));

    // The text appears in both the message bubble and the sidebar preview
    const found = await findAllByText('hi there');
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(scrollSpy).toHaveBeenCalledWith({ top: 500, behavior: 'smooth' });
  });

  it('ignores duplicate socket messages for the same id', async () => {
    chatMocks.messages.mockResolvedValue({
      data: { messages: [msg('m1', OTHER, 'old message')] },
    });
    const { findByText, getAllByText, container } = renderChat();

    await findByText('old message');

    act(() => {
      handlers['chat:message'](msg('m1', OTHER, 'old message'));
      handlers['message:new'](msg('m1', OTHER, 'old message'));
    });

    expect(getAllByText('old message')).toHaveLength(1);
    expect(container.querySelectorAll('.chat-messages .space-y-3 > div').length).toBeLessThan(3);
  });
});
