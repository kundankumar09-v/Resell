import '@testing-library/jest-dom';

// jsdom does not implement browser APIs used by scroll-reveal/motion
// components (IntersectionObserver, matchMedia, ResizeObserver). Provide
// inert stubs so component smoke tests can render.
class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
global.IntersectionObserver = MockIntersectionObserver;
global.IntersectionObserverEntry = global.IntersectionObserverEntry || class {};

if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  });
}

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = MockResizeObserver;

window.scrollTo = window.scrollTo || (() => {});
Element.prototype.scrollTo = Element.prototype.scrollTo || function () {};
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || function () {};
