import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act, waitFor, screen } from '@testing-library/react';
import { createRef } from 'react';
import { ThemeProvider, useTheme } from '../../contexts/ThemeContext';
import CallModal from '../../components/CallModal';

// ---------------------------------------------------------------------------
// ThemeContext behavioral tests
// ---------------------------------------------------------------------------

function ThemeProbe() {
  const { theme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button data-testid="toggle" onClick={toggleTheme}>
        toggle
      </button>
    </div>
  );
}

describe('ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('defaults to light, then toggles to dark with the class + persistence', () => {
    const { getByTestId } = render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );
    expect(getByTestId('theme').textContent).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('resell-theme')).toBe('light');

    fireEvent.click(getByTestId('toggle'));
    expect(getByTestId('theme').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('resell-theme')).toBe('dark');

    fireEvent.click(getByTestId('toggle'));
    expect(getByTestId('theme').textContent).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('resell-theme')).toBe('light');
  });

  it('restores the persisted theme on mount', () => {
    localStorage.setItem('resell-theme', 'dark');
    const { getByTestId } = render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );
    expect(getByTestId('theme').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('works without a provider via the default context (no crash)', () => {
    const { getByTestId } = render(<ThemeProbe />);
    expect(getByTestId('theme').textContent).toBe('light');
  });
});

// ---------------------------------------------------------------------------
// CallModal ICE / callId behavioral tests
// ---------------------------------------------------------------------------

const { handlers, emit } = vi.hoisted(() => ({
  handlers: {},
  emit: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { _id: 'me', name: 'Me' } }),
}));

vi.mock('../../contexts/SocketContext', () => ({
  useSocket: () => ({
    socket: { id: 'sock' },
    emit,
    on: (event, cb) => {
      handlers[event] = cb;
    },
    off: (event, cb) => {
      delete handlers[event];
    },
  }),
}));

// CallModal bare-identifiers resolve to window properties in jsdom.
const instances = [];
class MockRTCPeerConnection {
  constructor() {
    this.localDescription = null;
    this.remoteDescription = null;
    this._answered = false;
    this.addedCandidates = [];
    instances.push(this);
  }
  addTrack() {}
  async createOffer() {
    return { type: 'offer', sdp: 'offer-sdp' };
  }
  async setLocalDescription(d) {
    this.localDescription = d;
  }
  async setRemoteDescription(d) {
    this.remoteDescription = d;
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'answer-sdp' };
  }
  async addIceCandidate(c) {
    this.addedCandidates.push(c);
  }
  close() {}
}

const track = { enabled: true, stop: vi.fn() };
const mockStream = {
  getTracks: () => [track],
  getAudioTracks: () => [track],
};

describe('CallModal — answer, decline, hangup, timeout and cleanup behavior', () => {
  beforeEach(() => {
    instances.length = 0;
    Object.keys(handlers).forEach((k) => delete handlers[k]);
    emit.mockClear();
    track.stop.mockClear();
    track.enabled = true;
    window.RTCPeerConnection = MockRTCPeerConnection;
    window.RTCSessionDescription = class {
      constructor(init) {
        Object.assign(this, init);
      }
    };
    window.RTCIceCandidate = class {
      constructor(init) {
        Object.assign(this, init);
      }
    };
    if (!window.crypto || !window.crypto.randomUUID) {
      vi.stubGlobal('crypto', { randomUUID: () => 'test-call-uuid' });
    }
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => mockStream) },
      configurable: true,
    });
  });

  const receiveCall = (callId, from) => {
    act(() => {
      handlers['incomingCall']({
        signal: { type: 'offer', sdp: 'remote-offer' },
        from,
        callerName: 'Caller',
        callId,
      });
    });
  };

  it('accepting an incoming call runs the full callee flow: media, peer, answer', async () => {
    render(<CallModal ref={createRef()} />);
    receiveCall('call-acc-1', 'caller-1');

    await act(async () => {
      fireEvent.click(screen.getByText('Accept'));
    });

    await waitFor(() => {
      expect(emit).toHaveBeenCalledWith(
        'answerCall',
        expect.objectContaining({ to: 'caller-1', callId: 'call-acc-1' })
      );
    });

    // Media was requested, the peer exists, and the remote offer was applied.
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ video: false, audio: true });
    const peer = instances[instances.length - 1];
    expect(peer._answered).toBe(true);
    expect(peer.remoteDescription).toEqual({ type: 'offer', sdp: 'remote-offer' });
    expect(peer.localDescription).toEqual({ type: 'answer', sdp: 'answer-sdp' });

    // The modal moved to the active-call state.
    expect(screen.getByText('Active Call')).toBeTruthy();
  });

  it('caller applies a matching callAccepted and completes the SDP exchange', async () => {
    const ref = createRef();
    render(<CallModal ref={ref} />);

    await act(async () => {
      await ref.current.startCall('peer-1', 'Peer', 'conv-1');
    });

    expect(screen.getByText('Calling...')).toBeTruthy();

    const callId = emit.mock.calls.find(([e]) => e === 'callUser')[1].callId;
    await act(async () => {
      handlers['callAccepted']({ signal: { type: 'answer', sdp: 'remote-answer' }, callId });
    });

    const peer = instances[instances.length - 1];
    expect(peer.remoteDescription).toEqual({ type: 'answer', sdp: 'remote-answer' });
    expect(screen.getByText('Active Call')).toBeTruthy();
  });

  it('ignores a stale callAccepted from a different (previous) call', async () => {
    const ref = createRef();
    render(<CallModal ref={ref} />);

    await act(async () => {
      await ref.current.startCall('peer-2', 'Peer', 'conv-2');
    });

    const callId = emit.mock.calls.find(([e]) => e === 'callUser')[1].callId;
    await act(async () => {
      handlers['callAccepted']({ signal: { type: 'answer', sdp: 'stale-answer' }, callId: 'old-call-uuid' });
    });

    // The stale answer was never applied and the caller stays on "Calling..."
    const peer = instances[instances.length - 1];
    expect(peer.remoteDescription).toBeNull();
    expect(screen.getByText('Calling...')).toBeTruthy();
  });

  it('declining terminates cleanly and persists the rejection outcome', async () => {
    render(<CallModal ref={createRef()} />);
    receiveCall('call-dec-1', 'caller-1');

    await act(async () => {
      fireEvent.click(screen.getByText('Decline'));
    });

    expect(emit).toHaveBeenCalledWith(
      'endCall',
      expect.objectContaining({ to: 'caller-1', callId: 'call-dec-1', reason: 'rejected' })
    );
    // The callee never took media before accepting, so there is no stream to
    // stop — only the modal state is torn down.
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(screen.queryByTestId('call-modal')).toBeNull();
  });

  it('denies the call (no peer created) when microphone access fails', async () => {
    navigator.mediaDevices.getUserMedia = vi.fn(async () => {
      throw new DOMException('Permission denied', 'NotAllowedError');
    });
    render(<CallModal ref={createRef()} />);
    receiveCall('call-denied-1', 'caller-1');

    await act(async () => {
      fireEvent.click(screen.getByText('Accept'));
    });

    // The caller is notified so they do not stay on "Calling..." forever.
    await waitFor(() => {
      expect(emit).toHaveBeenCalledWith(
        'endCall',
        expect.objectContaining({ to: 'caller-1', callId: 'call-denied-1', reason: 'rejected' })
      );
    });
    // No RTCPeerConnection was ever created.
    expect(instances).toHaveLength(0);
    expect(screen.queryByTestId('call-modal')).toBeNull();
  });

  it('auto-declines an unanswered incoming call as missed after the timeout', async () => {
    vi.useFakeTimers();
    try {
      render(<CallModal ref={createRef()} />);
      receiveCall('call-timeout-1', 'caller-1');
      expect(screen.getByText('Incoming Call')).toBeTruthy();

      await act(async () => {
        vi.advanceTimersByTime(45000);
      });

      expect(emit).toHaveBeenCalledWith(
        'endCall',
        expect.objectContaining({ to: 'caller-1', callId: 'call-timeout-1', reason: 'missed' })
      );
      // Media was never taken (never accepted), so nothing to stop.
      expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
      expect(screen.queryByTestId('call-modal')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an unanswered outgoing call after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const ref = createRef();
      render(<CallModal ref={ref} />);

      await act(async () => {
        await ref.current.startCall('peer-3', 'Peer', 'conv-3');
      });
      expect(screen.getByText('Calling...')).toBeTruthy();

      await act(async () => {
        vi.advanceTimersByTime(45000);
      });

      expect(emit).toHaveBeenCalledWith(
        'endCall',
        expect.objectContaining({ to: 'peer-3', reason: 'cancelled' })
      );
      expect(track.stop).toHaveBeenCalled();
      expect(screen.queryByTestId('call-modal')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not time out a call that was accepted before the timeout', async () => {
    vi.useFakeTimers();
    try {
      const ref = createRef();
      render(<CallModal ref={ref} />);

      await act(async () => {
        await ref.current.startCall('peer-4', 'Peer', 'conv-4');
      });

      const callId = emit.mock.calls.find(([e]) => e === 'callUser')[1].callId;
      await act(async () => {
        handlers['callAccepted']({ signal: { type: 'answer', sdp: 'remote-answer' }, callId });
      });

      await act(async () => {
        vi.advanceTimersByTime(45000);
      });

      // The answered call survives the ring timeout.
      expect(screen.getByText('Active Call')).toBeTruthy();
      expect(emit).not.toHaveBeenCalledWith('endCall', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it('hanging up after connecting emits the completed outcome and cleans up', async () => {
    const ref = createRef();
    render(<CallModal ref={ref} />);
    receiveCall('call-hangup-1', 'caller-1');

    await act(async () => {
      fireEvent.click(screen.getByText('Accept'));
    });
    await waitFor(() => {
      expect(emit).toHaveBeenCalledWith('answerCall', expect.anything());
    });

    await act(async () => {
      fireEvent.click(screen.getByText('End Call'));
    });

    expect(emit).toHaveBeenCalledWith(
      'endCall',
      expect.objectContaining({ to: 'caller-1', callId: 'call-hangup-1', reason: 'completed' })
    );
    expect(track.stop).toHaveBeenCalled();
    expect(screen.queryByTestId('call-modal')).toBeNull();
  });

  it('marks the active call as Connected once the peer connection state changes', async () => {
    render(<CallModal ref={createRef()} />);
    receiveCall('call-conn-1', 'caller-1');

    await act(async () => {
      fireEvent.click(screen.getByText('Accept'));
    });
    await waitFor(() => {
      expect(emit).toHaveBeenCalledWith('answerCall', expect.anything());
    });

    expect(screen.getByText('Connecting...')).toBeTruthy();

    const peer = instances[instances.length - 1];
    act(() => {
      peer.connectionState = 'connected';
      peer.onconnectionstatechange();
    });

    expect(screen.getByText('Connected')).toBeTruthy();
  });

  it('cleans up the peer and stream when the component unmounts mid-call', async () => {
    const ref = createRef();
    const { unmount } = render(<CallModal ref={ref} />);
    receiveCall('call-unmount-1', 'caller-1');

    await act(async () => {
      fireEvent.click(screen.getByText('Accept'));
    });
    await waitFor(() => {
      expect(emit).toHaveBeenCalledWith('answerCall', expect.anything());
    });

    const peer = instances[instances.length - 1];
    const closeSpy = vi.spyOn(peer, 'close');

    unmount();

    expect(closeSpy).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });

  it('shows a terminated call as hidden and re-shows the modal for a new call', async () => {
    render(<CallModal ref={createRef()} />);
    receiveCall('call-stale-1', 'caller-1');

    await act(async () => {
      handlers['callEnded']({ callId: 'call-stale-1' });
    });
    expect(screen.queryByTestId('call-modal')).toBeNull();

    // A newer incoming call must still be shown and must not be tainted by
    // the terminated call's state.
    await act(async () => {
      handlers['incomingCall']({
        signal: { type: 'offer', sdp: 'new-offer' },
        from: 'caller-2',
        callerName: 'New Caller',
        callId: 'call-new-1',
      });
    });
    expect(screen.getByTestId('call-modal')).toBeTruthy();
    expect(screen.getByText('Incoming Call')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText('Accept'));
    });
    await waitFor(() => {
      expect(emit).toHaveBeenCalledWith(
        'answerCall',
        expect.objectContaining({ to: 'caller-2', callId: 'call-new-1' })
      );
    });
    const peer = instances[instances.length - 1];
    expect(peer.remoteDescription).toEqual({ type: 'offer', sdp: 'new-offer' });
  });

  it('is dark-theme aware (dedicated call-modal surface, no white block)', () => {
    document.documentElement.classList.add('dark');
    render(<CallModal ref={createRef()} />);
    receiveCall('call-dark-1', 'caller-1');

    const modal = screen.getByTestId('call-modal');
    expect(modal.className).toContain('call-modal');
    // The white-utility override must not be relied on: no bg-white class.
    expect(modal.className).not.toContain('bg-white');
    document.documentElement.classList.remove('dark');
  });
});

describe('CallModal — ICE buffering and callId scoping', () => {
  beforeEach(() => {
    instances.length = 0;
    Object.keys(handlers).forEach((k) => delete handlers[k]);
    emit.mockClear();
    track.stop.mockClear();
    window.RTCPeerConnection = MockRTCPeerConnection;
    window.RTCSessionDescription = class {
      constructor(init) {
        Object.assign(this, init);
      }
    };
    window.RTCIceCandidate = class {
      constructor(init) {
        Object.assign(this, init);
      }
    };
    if (!window.crypto || !window.crypto.randomUUID) {
      vi.stubGlobal('crypto', { randomUUID: () => 'test-call-uuid' });
    }
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => mockStream) },
      configurable: true,
    });
  });

  const receiveCall = (callId, from) => {
    act(() => {
      handlers['incomingCall']({
        signal: { type: 'offer', sdp: 'remote-offer' },
        from,
        callerName: 'Caller',
        callId,
      });
    });
  };

  it('buffers matching ICE candidates before the answer and rejects stale ones', async () => {
    render(<CallModal ref={createRef()} />);

    receiveCall('call-1', 'caller-1');

    // Candidates arrive before the callee answers:
    // - matching call-1 candidate -> buffered
    // - stale candidate from a different (previous) call -> rejected
    act(() => {
      handlers['iceCandidate']({ candidate: { candidate: 'c1' }, callId: 'call-1' });
      handlers['iceCandidate']({ candidate: { candidate: 'stale' }, callId: 'call-0' });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Accept'));
    });

    await waitFor(() => {
      expect(emit).toHaveBeenCalledWith(
        'answerCall',
        expect.objectContaining({ to: 'caller-1', callId: 'call-1' })
      );
    });

    // The flush after the answer applied only the matching candidate
    const peer = instances[instances.length - 1];
    expect(peer._answered).toBe(true);
    expect(peer.addedCandidates).toHaveLength(1);
    expect(peer.addedCandidates[0].candidate).toBe('c1');
  });

  it('adds candidates directly once the remote description is set and rejects stale callIds', async () => {
    render(<CallModal ref={createRef()} />);

    receiveCall('call-2', 'caller-2');
    await act(async () => {
      fireEvent.click(screen.getByText('Accept'));
    });

    const peer = instances[instances.length - 1];
    expect(peer.remoteDescription).toBeTruthy();

    act(() => {
      handlers['iceCandidate']({ candidate: { candidate: 'live' }, callId: 'call-2' });
      handlers['iceCandidate']({ candidate: { candidate: 'stale-2' }, callId: 'call-OLD' });
    });

    expect(peer.addedCandidates).toHaveLength(1);
    expect(peer.addedCandidates[0].candidate).toBe('live');
  });

  it('propagates the callId on callUser and outgoing ICE candidates', async () => {
    const ref = createRef();
    render(<CallModal ref={ref} />);

    await act(async () => {
      await ref.current.startCall('peer-9', 'Peer', 'conv-9');
    });

    expect(emit).toHaveBeenCalledWith(
      'callUser',
      expect.objectContaining({
        userToCall: 'peer-9',
        conversationId: 'conv-9',
        callId: expect.any(String),
      })
    );

    const peer = instances[instances.length - 1];
    peer.onicecandidate({ candidate: { candidate: 'outgoing-1' } });
    expect(emit).toHaveBeenCalledWith(
      'iceCandidate',
      expect.objectContaining({ to: 'peer-9', callId: expect.any(String) })
    );
  });
});
