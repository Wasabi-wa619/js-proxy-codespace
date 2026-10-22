/*
 * プロキシ経由のページに最初に読み込まれるスクリプト。
 * ページの JS から見た URL・通信・Cookie を「本来のサイト」に見せかけつつ、
 * 実際の通信は全て /p/<URL> 経由になるように各種 API をフックする。
 */
(function () {
  'use strict';

  var PREFIX = '/p/';
  var PROXIED_RE = /^\/p\/(https?|wss?):\/\/?/i;
  var SKIP_RE = /^\s*(data|blob|javascript|about|mailto|tel|sms|intent|chrome|chrome-extension|moz-extension):/i;
  var ORIGIN = location.origin !== 'null' ? location.origin : new URL(document.baseURI).origin;
  var WS_ORIGIN = ORIGIN.replace(/^http/, 'ws');

  var nativeToString = Function.prototype.toString;
  var disguised = new WeakMap();

  // フックした関数の toString() がネイティブに見えるようにする (検出対策)
  function disguise(fn, original) {
    try {
      disguised.set(fn, original);
      Object.defineProperty(fn, 'name', { value: original.name, configurable: true });
      Object.defineProperty(fn, 'length', { value: original.length, configurable: true });
    } catch (e) {}
    return fn;
  }

  /** プロキシURL -> 本来のURL。プロキシURLでなければ null */
  function toTarget(u) {
    if (u == null) return null;
    var x;
    try {
      x = new URL(String(u), ORIGIN);
    } catch (e) {
      return null;
    }
    var origin = x.origin.replace(/^ws/, 'http');
    if (origin !== ORIGIN) return null;
    var m = /^\/p\/(https?|wss?):\/\/?(.*)$/i.exec(x.pathname);
    if (!m) return null;
    return m[1].toLowerCase() + '://' + m[2] + x.search + x.hash;
  }

  function install(win) {
    try {
      if (!win || win.__pxInstalled) return;
      Object.defineProperty(win, '__pxInstalled', { value: true });
    } catch (e) {
      return; // 別オリジンのウィンドウ
    }

    var doc = win.document;
    var realLoc = win.location;
    var Elem = win.Element.prototype;
    var origSetAttribute = Elem.setAttribute;
    var origGetAttribute = Elem.getAttribute;
    var baseURIDesc = Object.getOwnPropertyDescriptor(win.Node.prototype, 'baseURI');

    function realBase() {
      try {
        return baseURIDesc.get.call(doc);
      } catch (e) {
        return realLoc.href;
      }
    }

    /** このウィンドウが表示している本来のURL */
    function targetHref() {
      return toTarget(realLoc.href) || toTarget(realBase());
    }
    function targetOrigin() {
      var t = targetHref();
      return t ? new URL(t).origin : ORIGIN;
    }
    function targetBase() {
      return toTarget(realBase()) || targetHref() || realLoc.href;
    }

    /** ページ内のURL -> プロキシURL */
    function encode(u, base) {
      if (u == null) return u;
      var s = String(u);
      if (s === '' || s.charAt(0) === '#' || SKIP_RE.test(s) || PROXIED_RE.test(s)) return s;
      var abs;
      try {
        abs = new URL(s, base || targetBase());
      } catch (e) {
        return s;
      }
      if (!/^(https?|wss?):$/.test(abs.protocol)) return s;
      var absOrigin = abs.origin.replace(/^ws/, 'http');
      if (absOrigin === ORIGIN) {
        // プロキシ自身のURLが混ざってきた場合
        if (PROXIED_RE.test(abs.pathname) || abs.pathname.indexOf('/__px/') === 0) {
          return abs.pathname + abs.search + abs.hash;
        }
        var t = targetHref();
        if (!t) return s;
        return PREFIX + new URL(t).origin + abs.pathname + abs.search + abs.hash;
      }
      return PREFIX + abs.href;
    }

    function encodeWs(u) {
      var s = String(u);
      var abs;
      try {
        abs = new URL(s, targetBase());
      } catch (e) {
        return s;
      }
      if (abs.origin.replace(/^ws/, 'http') === ORIGIN && PROXIED_RE.test(abs.pathname)) return abs.href;
      if (abs.protocol === 'http:') abs.protocol = 'ws:';
      if (abs.protocol === 'https:') abs.protocol = 'wss:';
      return WS_ORIGIN + PREFIX + abs.href;
    }

    function decode(u) {
      return toTarget(u) || u;
    }

    function encodeSrcset(v) {
      return String(v).replace(/(^|,)(\s*)(\S+)/g, function (all, sep, sp, url) {
        var trail = /,+$/.exec(url);
        url = url.replace(/,+$/, '');
        return sep + sp + encode(url) + (trail ? trail[0] : '');
      });
    }
    function decodeSrcset(v) {
      return v == null ? v : String(v).replace(/(^|,)(\s*)(\S+)/g, function (all, sep, sp, url) {
        return sep + sp + decode(url);
      });
    }

    function hookFn(obj, name, makeWrapper) {
      try {
        var orig = obj && obj[name];
        if (typeof orig !== 'function') return;
        var wrapped = disguise(makeWrapper(orig), orig);
        Object.defineProperty(obj, name, {
          value: wrapped,
          writable: true,
          configurable: true,
          enumerable: Object.getOwnPropertyDescriptor(obj, name)
            ? Object.getOwnPropertyDescriptor(obj, name).enumerable
            : false,
        });
      } catch (e) {}
    }

    function hookAccessor(obj, prop, getWrap, setWrap) {
      try {
        var d = obj && Object.getOwnPropertyDescriptor(obj, prop);
        if (!d || !d.configurable || !d.get) return;
        var desc = { configurable: true, enumerable: d.enumerable };
        desc.get = getWrap
          ? disguise(function () {
              return getWrap.call(this, d.get);
            }, d.get)
          : d.get;
        if (d.set) {
          desc.set = setWrap
            ? disguise(function (v) {
                setWrap.call(this, d.set, v);
              }, d.set)
            : d.set;
        }
        Object.defineProperty(obj, prop, desc);
      } catch (e) {}
    }

    function hookConstructor(name, mapArgs) {
      var Orig = win[name];
      if (typeof Orig !== 'function') return;
      var P = new Proxy(Orig, {
        construct: function (t, args, nt) {
          return Reflect.construct(t, mapArgs(args.slice()), nt === P ? t : nt);
        },
      });
      try {
        Object.defineProperty(win, name, { value: P, writable: true, configurable: true });
      } catch (e) {}
    }

    // ------------------------------------------------------------ location

    var fakes = new WeakMap();
    var fakeSet = new WeakSet();

    function isLocation(x) {
      if (!x || typeof x !== 'object' || fakeSet.has(x)) return false;
      try {
        return Object.prototype.toString.call(x) === '[object Location]';
      } catch (e) {
        return false; // 別オリジンの Location
      }
    }

    function fakeLocation(rl) {
      var f = fakes.get(rl);
      if (f) return f;
      var proto;
      try {
        proto = Object.getPrototypeOf(rl);
      } catch (e) {
        proto = Object.prototype;
      }
      f = Object.create(proto);
      var current = function () {
        return new URL(toTarget(rl.href) || rl.href);
      };
      var go = function (u, replace) {
        var enc = encode(u, current().href);
        if (replace) rl.replace(enc);
        else rl.assign(enc);
      };
      ['href', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin'].forEach(function (p) {
        var desc = {
          enumerable: true,
          configurable: true,
          get: function () {
            return current()[p];
          },
        };
        if (p !== 'origin') {
          desc.set = function (v) {
            if (p === 'href') return go(v);
            if (p === 'hash') {
              rl.hash = v;
              return;
            }
            var u = current();
            u[p] = v;
            go(u.href);
          };
        }
        Object.defineProperty(f, p, desc);
      });
      var methods = {
        assign: function (u) {
          go(u);
        },
        replace: function (u) {
          go(u, true);
        },
        reload: function () {
          rl.reload();
        },
        toString: function () {
          return current().href;
        },
      };
      Object.keys(methods).forEach(function (k) {
        Object.defineProperty(f, k, { value: methods[k], configurable: true, writable: true });
      });
      Object.defineProperty(f, 'ancestorOrigins', {
        get: function () {
          return rl.ancestorOrigins;
        },
        configurable: true,
      });
      fakes.set(rl, f);
      fakeSet.add(f);
      return f;
    }

    function defineGlobal(name, fn) {
      Object.defineProperty(win, name, { value: fn, configurable: true, writable: true });
    }
    // サーバー側で書き換えた JS から呼ばれる関数 (src/js.js 参照)
    defineGlobal('__pxL', function (x) {
      return isLocation(x) ? fakeLocation(x) : x;
    });
    defineGlobal('__pxA', function (cur, v) {
      return isLocation(cur) ? encode(v, fakeLocation(cur).href) : v;
    });
    defineGlobal('__pxSet', function (obj, v) {
      var cur;
      try {
        cur = obj.location;
      } catch (e) {}
      if (isLocation(cur)) {
        fakeLocation(cur).href = v;
        return v;
      }
      return (obj.location = v);
    });

    // ------------------------------------------------------------ document / window のURL系プロパティ

    // ブラウザによって定義場所が Document / HTMLDocument と異なるので実際の持ち主を探す
    function ownerOf(obj, prop) {
      while (obj && !Object.prototype.hasOwnProperty.call(obj, prop)) obj = Object.getPrototypeOf(obj);
      return obj;
    }
    hookAccessor(ownerOf(doc, 'URL'), 'URL', function (g) {
      return decode(g.call(this));
    });
    hookAccessor(ownerOf(doc, 'documentURI'), 'documentURI', function (g) {
      return decode(g.call(this));
    });
    hookAccessor(ownerOf(doc, 'referrer'), 'referrer', function (g) {
      var r = g.call(this);
      if (!r) return r;
      var t = toTarget(r);
      if (t) return t;
      return new URL(r).origin === ORIGIN ? '' : r;
    });
    hookAccessor(
      ownerOf(doc, 'domain'),
      'domain',
      function (g) {
        var t = targetHref();
        return t ? new URL(t).hostname : g.call(this);
      },
      function () {
        /* document.domain の変更は無視する */
      },
    );
    hookAccessor(win.Node.prototype, 'baseURI', function (g) {
      return decode(g.call(this));
    });
    try {
      Object.defineProperty(win, 'origin', {
        get: function () {
          return targetOrigin();
        },
        set: function () {},
        configurable: true,
      });
    } catch (e) {}

    // ------------------------------------------------------------ Cookie

    hookAccessor(
      ownerOf(doc, 'cookie'),
      'cookie',
      function (g) {
        return String(g.call(this))
          .split(/;\s*/)
          .filter(function (c) {
            return c && c.indexOf('__px_') !== 0;
          })
          .map(function (c) {
            return c.replace(/^__PXH_/, '__Host-').replace(/^__PXS_/, '__Secure-');
          })
          .join('; ');
      },
      function (s, v) {
        var parts = String(v).split(';');
        var pair = parts.shift().replace(/^\s*__Host-/, '__PXH_').replace(/^\s*__Secure-/, '__PXS_');
        var path = '/';
        var attrs = [];
        var secure = ORIGIN.indexOf('https:') === 0;
        parts.forEach(function (a) {
          var t = a.trim();
          var k = t.split('=')[0].trim().toLowerCase();
          if (!t || k === 'domain' || k === 'partitioned') return;
          if (k === 'path') {
            var p = t.slice(t.indexOf('=') + 1).trim();
            if (p.charAt(0) === '/') path = p;
            return;
          }
          if (!secure && (k === 'secure' || k === 'samesite')) return;
          attrs.push(t);
        });
        attrs.unshift('Path=' + PREFIX + targetOrigin() + path);
        s.call(this, [pair].concat(attrs).join('; '));
      },
    );

    // ------------------------------------------------------------ 通信系 API

    hookFn(win, 'fetch', function (orig) {
      return function (input, init) {
        try {
          if (input instanceof win.Request) {
            var enc = encode(input.url);
            if (enc !== input.url) input = new win.Request(enc, input);
          } else if (input != null) {
            input = encode(input instanceof win.URL ? input.href : String(input));
          }
        } catch (e) {}
        return orig.call(this === undefined || this === win ? win : this, input, init);
      };
    });
    hookAccessor(win.Request && win.Request.prototype, 'url', function (g) {
      return decode(g.call(this));
    });
    hookAccessor(win.Response && win.Response.prototype, 'url', function (g) {
      return decode(g.call(this));
    });

    var XHRP = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
    hookFn(XHRP, 'open', function (orig) {
      return function (method, url) {
        var args = Array.prototype.slice.call(arguments);
        if (args.length > 1) args[1] = encode(url);
        return orig.apply(this, args);
      };
    });
    hookAccessor(XHRP, 'responseURL', function (g) {
      return decode(g.call(this));
    });

    if (win.Navigator) {
      hookFn(win.Navigator.prototype, 'sendBeacon', function (orig) {
        return function (url, data) {
          return orig.call(this, encode(url), data);
        };
      });
    }

    hookConstructor('WebSocket', function (args) {
      if (args.length) args[0] = encodeWs(args[0]);
      return args;
    });
    hookAccessor(win.WebSocket && win.WebSocket.prototype, 'url', function (g) {
      var u = g.call(this);
      var t = toTarget(u.replace(/^ws/, 'http'));
      return t ? t.replace(/^http/, 'ws') : u;
    });
    ['EventSource', 'Worker', 'SharedWorker'].forEach(function (name) {
      hookConstructor(name, function (args) {
        if (args.length) args[0] = encode(args[0] instanceof win.URL ? args[0].href : args[0]);
        return args;
      });
    });
    hookAccessor(win.EventSource && win.EventSource.prototype, 'url', function (g) {
      return decode(g.call(this));
    });

    hookFn(win, 'open', function (orig) {
      return function (url) {
        var args = Array.prototype.slice.call(arguments);
        if (args.length && args[0] != null && args[0] !== '') args[0] = encode(args[0]);
        var w = orig.apply(this === undefined ? win : this, args);
        try {
          if (w) install(w);
        } catch (e) {}
        return w;
      };
    });

    var HistP = win.History && win.History.prototype;
    ['pushState', 'replaceState'].forEach(function (name) {
      hookFn(HistP, name, function (orig) {
        return function (state, title, url) {
          var args = Array.prototype.slice.call(arguments);
          if (args.length > 2 && url != null) args[2] = encode(url);
          return orig.apply(this, args);
        };
      });
    });

    // postMessage: 宛先オリジンは本来のサイトのものが指定されるので '*' に緩める
    hookFn(win, 'postMessage', function (orig) {
      return function (msg, targetOrigin) {
        var args = Array.prototype.slice.call(arguments);
        if (typeof targetOrigin === 'string' && targetOrigin !== '*' && targetOrigin !== '/') {
          args[1] = '*';
        } else if (targetOrigin && typeof targetOrigin === 'object' && typeof targetOrigin.targetOrigin === 'string') {
          args[1] = Object.assign({}, targetOrigin, { targetOrigin: '*' });
        }
        return orig.apply(this === undefined ? win : this, args);
      };
    });
    hookAccessor(win.MessageEvent && win.MessageEvent.prototype, 'origin', function (g) {
      var o = g.call(this);
      if (o !== ORIGIN) return o;
      try {
        var src = this.source;
        var t = src && toTarget(src.location.href);
        if (t) return new URL(t).origin;
      } catch (e) {}
      return targetOrigin();
    });

    // ------------------------------------------------------------ Service Worker

    var swc = win.navigator.serviceWorker;
    var SWCP = win.ServiceWorkerContainer && win.ServiceWorkerContainer.prototype;
    var origRegister = SWCP && SWCP.register;
    if (swc && origRegister && win === win.top && !swc.controller) {
      try {
        origRegister.call(swc, '/__px/sw.js', { scope: '/' }).catch(function () {});
      } catch (e) {}
    }
    if (SWCP) {
      // サイト独自の SW はプロキシの SW を乗っ取ってしまうので登録させない
      hookFn(SWCP, 'register', function () {
        return function () {
          return Promise.reject(new win.DOMException('Service Worker is disabled by proxy', 'SecurityError'));
        };
      });
      hookFn(SWCP, 'getRegistrations', function () {
        return function () {
          return Promise.resolve([]);
        };
      });
      hookFn(SWCP, 'getRegistration', function () {
        return function () {
          return Promise.resolve(undefined);
        };
      });
    }

    // ------------------------------------------------------------ DOM の URL 属性

    var URL_ATTRS = {
      A: ['href'],
      AREA: ['href'],
      LINK: ['href'],
      BASE: ['href'],
      IMG: ['src'],
      SCRIPT: ['src'],
      IFRAME: ['src'],
      FRAME: ['src'],
      EMBED: ['src'],
      SOURCE: ['src'],
      TRACK: ['src'],
      AUDIO: ['src'],
      VIDEO: ['src', 'poster'],
      INPUT: ['src', 'formaction'],
      BUTTON: ['formaction'],
      FORM: ['action'],
      OBJECT: ['data'],
    };
    var SRCSET_TAGS = { IMG: 1, SOURCE: 1 };

    function attrKind(el, name) {
      var tag = el.tagName && el.tagName.toUpperCase();
      var n = String(name).toLowerCase();
      if (n === 'srcset' && SRCSET_TAGS[tag]) return 'srcset';
      var list = URL_ATTRS[tag];
      if (list && list.indexOf(n) !== -1) return 'url';
      if ((n === 'href' || n === 'xlink:href') && (tag === 'IMAGE' || tag === 'USE')) return 'url';
      if (n === 'integrity' || n === 'nonce') return 'drop';
      return null;
    }

    hookFn(Elem, 'setAttribute', function (orig) {
      return function (name, value) {
        var k = attrKind(this, name);
        if (k === 'drop') return;
        if (k === 'url') value = encode(value);
        else if (k === 'srcset') value = encodeSrcset(value);
        return orig.call(this, name, value);
      };
    });
    hookFn(Elem, 'getAttribute', function (orig) {
      return function (name) {
        var v = orig.call(this, name);
        if (v == null) return v;
        var k = attrKind(this, name);
        if (k === 'url') return decode(v);
        if (k === 'srcset') return decodeSrcset(v);
        return v;
      };
    });

    [
      ['HTMLAnchorElement', 'href'],
      ['HTMLAreaElement', 'href'],
      ['HTMLLinkElement', 'href'],
      ['HTMLBaseElement', 'href'],
      ['HTMLImageElement', 'src'],
      ['HTMLScriptElement', 'src'],
      ['HTMLIFrameElement', 'src'],
      ['HTMLFrameElement', 'src'],
      ['HTMLEmbedElement', 'src'],
      ['HTMLSourceElement', 'src'],
      ['HTMLTrackElement', 'src'],
      ['HTMLMediaElement', 'src'],
      ['HTMLInputElement', 'src'],
      ['HTMLFormElement', 'action'],
      ['HTMLButtonElement', 'formAction'],
      ['HTMLInputElement', 'formAction'],
      ['HTMLVideoElement', 'poster'],
      ['HTMLObjectElement', 'data'],
    ].forEach(function (pair) {
      var C = win[pair[0]];
      var attr = pair[1].toLowerCase();
      hookAccessor(
        C && C.prototype,
        pair[1],
        function (g) {
          return decode(g.call(this));
        },
        function (s, v) {
          origSetAttribute.call(this, attr, encode(v));
        },
      );
    });
    ['HTMLImageElement', 'HTMLSourceElement'].forEach(function (name) {
      var C = win[name];
      hookAccessor(
        C && C.prototype,
        'srcset',
        function (g) {
          return decodeSrcset(g.call(this));
        },
        function (s, v) {
          origSetAttribute.call(this, 'srcset', encodeSrcset(v));
        },
      );
    });
    ['HTMLScriptElement', 'HTMLLinkElement'].forEach(function (name) {
      var C = win[name];
      hookAccessor(
        C && C.prototype,
        'integrity',
        function () {
          return '';
        },
        function () {},
      );
    });

    // <a> の hostname / pathname なども本来のURLで返す
    ['HTMLAnchorElement', 'HTMLAreaElement'].forEach(function (name) {
      var C = win[name];
      if (!C) return;
      ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin'].forEach(function (p) {
        hookAccessor(
          C.prototype,
          p,
          function (g) {
            var raw = origGetAttribute.call(this, 'href');
            if (raw == null) return g.call(this);
            try {
              return new URL(this.href)[p];
            } catch (e) {
              return g.call(this);
            }
          },
          function (s, v) {
            try {
              var u = new URL(this.href);
              u[p] = v;
              this.href = u.href;
            } catch (e) {
              s.call(this, v);
            }
          },
        );
      });
      hookFn(C.prototype, 'toString', function () {
        return function () {
          return this.href;
        };
      });
    });

    // about:blank の iframe はサーバーを通らないので、アクセスされた時点でフックを入れる
    [
      ['HTMLIFrameElement', 'contentWindow'],
      ['HTMLIFrameElement', 'contentDocument'],
      ['HTMLFrameElement', 'contentWindow'],
      ['HTMLFrameElement', 'contentDocument'],
      ['HTMLObjectElement', 'contentWindow'],
      ['HTMLObjectElement', 'contentDocument'],
    ].forEach(function (pair) {
      var C = win[pair[0]];
      hookAccessor(C && C.prototype, pair[1], function (g) {
        var r = g.call(this);
        try {
          var w = pair[1] === 'contentWindow' ? r : r && r.defaultView;
          if (w) install(w);
        } catch (e) {}
        return r;
      });
    });

    // innerHTML 等で後から追加された要素の URL 属性を補正する
    function fixElement(el) {
      var list = URL_ATTRS[el.tagName];
      if (list) {
        for (var i = 0; i < list.length; i++) {
          var raw = origGetAttribute.call(el, list[i]);
          if (raw == null) continue;
          var t = raw.trim();
          // 相対パス (img/a.png) はそのままでも正しく解決されるので触らない
          if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(t) && t.charAt(0) !== '/') continue;
          var enc = encode(raw);
          if (enc !== raw) origSetAttribute.call(el, list[i], enc);
        }
      }
      if (SRCSET_TAGS[el.tagName]) {
        var ss = origGetAttribute.call(el, 'srcset');
        if (ss) {
          var e2 = encodeSrcset(ss);
          if (e2 !== ss) origSetAttribute.call(el, 'srcset', e2);
        }
      }
    }
    var SELECTOR = 'a[href],area[href],link[href],img,script[src],iframe[src],frame[src],embed[src],source,track[src],audio[src],video,input[src],input[formaction],button[formaction],form[action],object[data]';
    try {
      new win.MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var nodes = records[i].addedNodes;
          for (var j = 0; j < nodes.length; j++) {
            var n = nodes[j];
            if (n.nodeType !== 1) continue;
            fixElement(n);
            if (n.firstElementChild) {
              var found = n.querySelectorAll(SELECTOR);
              for (var k = 0; k < found.length; k++) fixElement(found[k]);
            }
          }
        }
      }).observe(doc, { childList: true, subtree: true });
    } catch (e) {}

    // リンクのクリック・フォーム送信の直前にも念のため補正する
    doc.addEventListener(
      'click',
      function (e) {
        var a = e.target && e.target.closest && e.target.closest('a[href],area[href]');
        if (a) fixElement(a);
      },
      true,
    );
    doc.addEventListener(
      'submit',
      function (e) {
        if (e.target && e.target.tagName === 'FORM') fixElement(e.target);
      },
      true,
    );

    // location.href = ... などで取りこぼした遷移を Navigation API で拾う (Chromium 系)
    if (win.navigation && win.navigation.addEventListener) {
      win.navigation.addEventListener('navigate', function (e) {
        if (!e.cancelable || e.hashChange || e.downloadRequest != null || e.formData) return;
        var u;
        try {
          u = new URL(e.destination.url);
        } catch (err) {
          return;
        }
        if (!/^https?:$/.test(u.protocol)) return;
        var mapped = null;
        if (u.origin !== ORIGIN) {
          mapped = PREFIX + u.href;
        } else if (!PROXIED_RE.test(u.pathname) && u.pathname.indexOf('/__px/') !== 0 && targetHref()) {
          mapped = PREFIX + targetOrigin() + u.pathname + u.search + u.hash;
        }
        if (!mapped) return;
        e.preventDefault();
        if (e.navigationType === 'replace') realLoc.replace(mapped);
        else realLoc.assign(mapped);
      });
    }

    // ------------------------------------------------------------ 仕上げ

    if (win === window) {
      var fnToString = disguise(function () {
        var o = disguised.get(this);
        return nativeToString.call(o || this);
      }, nativeToString);
      try {
        Object.defineProperty(Function.prototype, 'toString', { value: fnToString, writable: true, configurable: true });
      } catch (e) {}
    }
  }

  install(window);
})();
