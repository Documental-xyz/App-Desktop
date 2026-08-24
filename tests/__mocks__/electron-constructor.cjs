'use strict';

// vitest 4 mock functions created from arrow implementations (`vi.fn(() => obj)`)
// have no [[Construct]] slot, so `new MockedClass()` inside source code throws
// "not a constructor". `asConstructable(fn)` wraps such mocks transparently:
// `new wrapped()` returns the implementation's return value (jest-style
// mock-constructor semantics); static props and normal calls forward to the
// original mock so assertions keep recording on it.

const constructableCache = new WeakMap();

function asConstructable(fn) {
  if (typeof fn !== 'function' || !fn.mock) {
    return fn;
  }
  let proxy = constructableCache.get(fn);
  if (proxy) return proxy;
  const wrapper = function patchedConstructor(...args) {
    const result = fn.apply(this, args);
    return result === undefined ? this : result;
  };
  wrapper.prototype = { constructor: wrapper };
  proxy = new Proxy(wrapper, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return fn[prop];
    },
    has(target, prop) {
      return prop in target || prop in fn;
    },
    set(target, prop, value) {
      try {
        fn[prop] = value;
      } catch {
        /* frozen mock — ignore */
      }
      target[prop] = value;
      return true;
    }
  });
  constructableCache.set(fn, proxy);
  return proxy;
}

module.exports = { asConstructable };
