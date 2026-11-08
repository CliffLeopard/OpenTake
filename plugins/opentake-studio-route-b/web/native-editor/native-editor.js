//#region \0rolldown/runtime.js
var e = Object.create, t = Object.defineProperty, n = Object.getOwnPropertyDescriptor, r = Object.getOwnPropertyNames, i = Object.getPrototypeOf, a = Object.prototype.hasOwnProperty, o = (e, t) => () => (t || (e((t = { exports: {} }).exports, t), e = null), t.exports), s = (e, i, o, s) => {
	if (i && typeof i == "object" || typeof i == "function") for (var c = r(i), l = 0, u = c.length, d; l < u; l++) d = c[l], !a.call(e, d) && d !== o && t(e, d, {
		get: ((e) => i[e]).bind(null, d),
		enumerable: !(s = n(i, d)) || s.enumerable
	});
	return e;
}, c = (n, r, a) => (a = n == null ? {} : e(i(n)), s(r || !n || !n.__esModule ? t(a, "default", {
	value: n,
	enumerable: !0
}) : a, n)), l = /* @__PURE__ */ o(((e) => {
	var t = Symbol.for("react.element"), n = Symbol.for("react.portal"), r = Symbol.for("react.fragment"), i = Symbol.for("react.strict_mode"), a = Symbol.for("react.profiler"), o = Symbol.for("react.provider"), s = Symbol.for("react.context"), c = Symbol.for("react.forward_ref"), l = Symbol.for("react.suspense"), u = Symbol.for("react.memo"), d = Symbol.for("react.lazy"), f = Symbol.iterator;
	function p(e) {
		return typeof e != "object" || !e ? null : (e = f && e[f] || e["@@iterator"], typeof e == "function" ? e : null);
	}
	var m = {
		isMounted: function() {
			return !1;
		},
		enqueueForceUpdate: function() {},
		enqueueReplaceState: function() {},
		enqueueSetState: function() {}
	}, h = Object.assign, g = {};
	function _(e, t, n) {
		this.props = e, this.context = t, this.refs = g, this.updater = n || m;
	}
	_.prototype.isReactComponent = {}, _.prototype.setState = function(e, t) {
		if (typeof e != "object" && typeof e != "function" && e != null) throw Error("setState(...): takes an object of state variables to update or a function which returns an object of state variables.");
		this.updater.enqueueSetState(this, e, t, "setState");
	}, _.prototype.forceUpdate = function(e) {
		this.updater.enqueueForceUpdate(this, e, "forceUpdate");
	};
	function v() {}
	v.prototype = _.prototype;
	function y(e, t, n) {
		this.props = e, this.context = t, this.refs = g, this.updater = n || m;
	}
	var b = y.prototype = new v();
	b.constructor = y, h(b, _.prototype), b.isPureReactComponent = !0;
	var x = Array.isArray, ee = Object.prototype.hasOwnProperty, S = { current: null }, te = {
		key: !0,
		ref: !0,
		__self: !0,
		__source: !0
	};
	function C(e, n, r) {
		var i, a = {}, o = null, s = null;
		if (n != null) for (i in n.ref !== void 0 && (s = n.ref), n.key !== void 0 && (o = "" + n.key), n) ee.call(n, i) && !te.hasOwnProperty(i) && (a[i] = n[i]);
		var c = arguments.length - 2;
		if (c === 1) a.children = r;
		else if (1 < c) {
			for (var l = Array(c), u = 0; u < c; u++) l[u] = arguments[u + 2];
			a.children = l;
		}
		if (e && e.defaultProps) for (i in c = e.defaultProps, c) a[i] === void 0 && (a[i] = c[i]);
		return {
			$$typeof: t,
			type: e,
			key: o,
			ref: s,
			props: a,
			_owner: S.current
		};
	}
	function ne(e, n) {
		return {
			$$typeof: t,
			type: e.type,
			key: n,
			ref: e.ref,
			props: e.props,
			_owner: e._owner
		};
	}
	function re(e) {
		return typeof e == "object" && !!e && e.$$typeof === t;
	}
	function w(e) {
		var t = {
			"=": "=0",
			":": "=2"
		};
		return "$" + e.replace(/[=:]/g, function(e) {
			return t[e];
		});
	}
	var T = /\/+/g;
	function ie(e, t) {
		return typeof e == "object" && e && e.key != null ? w("" + e.key) : t.toString(36);
	}
	function ae(e, r, i, a, o) {
		var s = typeof e;
		(s === "undefined" || s === "boolean") && (e = null);
		var c = !1;
		if (e === null) c = !0;
		else switch (s) {
			case "string":
			case "number":
				c = !0;
				break;
			case "object": switch (e.$$typeof) {
				case t:
				case n: c = !0;
			}
		}
		if (c) return c = e, o = o(c), e = a === "" ? "." + ie(c, 0) : a, x(o) ? (i = "", e != null && (i = e.replace(T, "$&/") + "/"), ae(o, r, i, "", function(e) {
			return e;
		})) : o != null && (re(o) && (o = ne(o, i + (!o.key || c && c.key === o.key ? "" : ("" + o.key).replace(T, "$&/") + "/") + e)), r.push(o)), 1;
		if (c = 0, a = a === "" ? "." : a + ":", x(e)) for (var l = 0; l < e.length; l++) {
			s = e[l];
			var u = a + ie(s, l);
			c += ae(s, r, i, u, o);
		}
		else if (u = p(e), typeof u == "function") for (e = u.call(e), l = 0; !(s = e.next()).done;) s = s.value, u = a + ie(s, l++), c += ae(s, r, i, u, o);
		else if (s === "object") throw r = String(e), Error("Objects are not valid as a React child (found: " + (r === "[object Object]" ? "object with keys {" + Object.keys(e).join(", ") + "}" : r) + "). If you meant to render a collection of children, use an array instead.");
		return c;
	}
	function oe(e, t, n) {
		if (e == null) return e;
		var r = [], i = 0;
		return ae(e, r, "", "", function(e) {
			return t.call(n, e, i++);
		}), r;
	}
	function se(e) {
		if (e._status === -1) {
			var t = e._result;
			t = t(), t.then(function(t) {
				(e._status === 0 || e._status === -1) && (e._status = 1, e._result = t);
			}, function(t) {
				(e._status === 0 || e._status === -1) && (e._status = 2, e._result = t);
			}), e._status === -1 && (e._status = 0, e._result = t);
		}
		if (e._status === 1) return e._result.default;
		throw e._result;
	}
	var E = { current: null }, D = { transition: null }, ce = {
		ReactCurrentDispatcher: E,
		ReactCurrentBatchConfig: D,
		ReactCurrentOwner: S
	};
	function O() {
		throw Error("act(...) is not supported in production builds of React.");
	}
	e.Children = {
		map: oe,
		forEach: function(e, t, n) {
			oe(e, function() {
				t.apply(this, arguments);
			}, n);
		},
		count: function(e) {
			var t = 0;
			return oe(e, function() {
				t++;
			}), t;
		},
		toArray: function(e) {
			return oe(e, function(e) {
				return e;
			}) || [];
		},
		only: function(e) {
			if (!re(e)) throw Error("React.Children.only expected to receive a single React element child.");
			return e;
		}
	}, e.Component = _, e.Fragment = r, e.Profiler = a, e.PureComponent = y, e.StrictMode = i, e.Suspense = l, e.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED = ce, e.act = O, e.cloneElement = function(e, n, r) {
		if (e == null) throw Error("React.cloneElement(...): The argument must be a React element, but you passed " + e + ".");
		var i = h({}, e.props), a = e.key, o = e.ref, s = e._owner;
		if (n != null) {
			if (n.ref !== void 0 && (o = n.ref, s = S.current), n.key !== void 0 && (a = "" + n.key), e.type && e.type.defaultProps) var c = e.type.defaultProps;
			for (l in n) ee.call(n, l) && !te.hasOwnProperty(l) && (i[l] = n[l] === void 0 && c !== void 0 ? c[l] : n[l]);
		}
		var l = arguments.length - 2;
		if (l === 1) i.children = r;
		else if (1 < l) {
			c = Array(l);
			for (var u = 0; u < l; u++) c[u] = arguments[u + 2];
			i.children = c;
		}
		return {
			$$typeof: t,
			type: e.type,
			key: a,
			ref: o,
			props: i,
			_owner: s
		};
	}, e.createContext = function(e) {
		return e = {
			$$typeof: s,
			_currentValue: e,
			_currentValue2: e,
			_threadCount: 0,
			Provider: null,
			Consumer: null,
			_defaultValue: null,
			_globalName: null
		}, e.Provider = {
			$$typeof: o,
			_context: e
		}, e.Consumer = e;
	}, e.createElement = C, e.createFactory = function(e) {
		var t = C.bind(null, e);
		return t.type = e, t;
	}, e.createRef = function() {
		return { current: null };
	}, e.forwardRef = function(e) {
		return {
			$$typeof: c,
			render: e
		};
	}, e.isValidElement = re, e.lazy = function(e) {
		return {
			$$typeof: d,
			_payload: {
				_status: -1,
				_result: e
			},
			_init: se
		};
	}, e.memo = function(e, t) {
		return {
			$$typeof: u,
			type: e,
			compare: t === void 0 ? null : t
		};
	}, e.startTransition = function(e) {
		var t = D.transition;
		D.transition = {};
		try {
			e();
		} finally {
			D.transition = t;
		}
	}, e.unstable_act = O, e.useCallback = function(e, t) {
		return E.current.useCallback(e, t);
	}, e.useContext = function(e) {
		return E.current.useContext(e);
	}, e.useDebugValue = function() {}, e.useDeferredValue = function(e) {
		return E.current.useDeferredValue(e);
	}, e.useEffect = function(e, t) {
		return E.current.useEffect(e, t);
	}, e.useId = function() {
		return E.current.useId();
	}, e.useImperativeHandle = function(e, t, n) {
		return E.current.useImperativeHandle(e, t, n);
	}, e.useInsertionEffect = function(e, t) {
		return E.current.useInsertionEffect(e, t);
	}, e.useLayoutEffect = function(e, t) {
		return E.current.useLayoutEffect(e, t);
	}, e.useMemo = function(e, t) {
		return E.current.useMemo(e, t);
	}, e.useReducer = function(e, t, n) {
		return E.current.useReducer(e, t, n);
	}, e.useRef = function(e) {
		return E.current.useRef(e);
	}, e.useState = function(e) {
		return E.current.useState(e);
	}, e.useSyncExternalStore = function(e, t, n) {
		return E.current.useSyncExternalStore(e, t, n);
	}, e.useTransition = function() {
		return E.current.useTransition();
	}, e.version = "18.3.1";
})), u = /* @__PURE__ */ o(((e, t) => {
	t.exports = l();
})), d = /* @__PURE__ */ o(((e) => {
	function t(e, t) {
		var n = e.length;
		e.push(t);
		a: for (; 0 < n;) {
			var r = n - 1 >>> 1, a = e[r];
			if (0 < i(a, t)) e[r] = t, e[n] = a, n = r;
			else break a;
		}
	}
	function n(e) {
		return e.length === 0 ? null : e[0];
	}
	function r(e) {
		if (e.length === 0) return null;
		var t = e[0], n = e.pop();
		if (n !== t) {
			e[0] = n;
			a: for (var r = 0, a = e.length, o = a >>> 1; r < o;) {
				var s = 2 * (r + 1) - 1, c = e[s], l = s + 1, u = e[l];
				if (0 > i(c, n)) l < a && 0 > i(u, c) ? (e[r] = u, e[l] = n, r = l) : (e[r] = c, e[s] = n, r = s);
				else if (l < a && 0 > i(u, n)) e[r] = u, e[l] = n, r = l;
				else break a;
			}
		}
		return t;
	}
	function i(e, t) {
		var n = e.sortIndex - t.sortIndex;
		return n === 0 ? e.id - t.id : n;
	}
	if (typeof performance == "object" && typeof performance.now == "function") {
		var a = performance;
		e.unstable_now = function() {
			return a.now();
		};
	} else {
		var o = Date, s = o.now();
		e.unstable_now = function() {
			return o.now() - s;
		};
	}
	var c = [], l = [], u = 1, d = null, f = 3, p = !1, m = !1, h = !1, g = typeof setTimeout == "function" ? setTimeout : null, _ = typeof clearTimeout == "function" ? clearTimeout : null, v = typeof setImmediate < "u" ? setImmediate : null;
	typeof navigator < "u" && navigator.scheduling !== void 0 && navigator.scheduling.isInputPending !== void 0 && navigator.scheduling.isInputPending.bind(navigator.scheduling);
	function y(e) {
		for (var i = n(l); i !== null;) {
			if (i.callback === null) r(l);
			else if (i.startTime <= e) r(l), i.sortIndex = i.expirationTime, t(c, i);
			else break;
			i = n(l);
		}
	}
	function b(e) {
		if (h = !1, y(e), !m) if (n(c) !== null) m = !0, oe(x);
		else {
			var t = n(l);
			t !== null && se(b, t.startTime - e);
		}
	}
	function x(t, i) {
		m = !1, h && (h = !1, _(te), te = -1), p = !0;
		var a = f;
		try {
			for (y(i), d = n(c); d !== null && (!(d.expirationTime > i) || t && !re());) {
				var o = d.callback;
				if (typeof o == "function") {
					d.callback = null, f = d.priorityLevel;
					var s = o(d.expirationTime <= i);
					i = e.unstable_now(), typeof s == "function" ? d.callback = s : d === n(c) && r(c), y(i);
				} else r(c);
				d = n(c);
			}
			if (d !== null) var u = !0;
			else {
				var g = n(l);
				g !== null && se(b, g.startTime - i), u = !1;
			}
			return u;
		} finally {
			d = null, f = a, p = !1;
		}
	}
	var ee = !1, S = null, te = -1, C = 5, ne = -1;
	function re() {
		return !(e.unstable_now() - ne < C);
	}
	function w() {
		if (S !== null) {
			var t = e.unstable_now();
			ne = t;
			var n = !0;
			try {
				n = S(!0, t);
			} finally {
				n ? T() : (ee = !1, S = null);
			}
		} else ee = !1;
	}
	var T;
	if (typeof v == "function") T = function() {
		v(w);
	};
	else if (typeof MessageChannel < "u") {
		var ie = new MessageChannel(), ae = ie.port2;
		ie.port1.onmessage = w, T = function() {
			ae.postMessage(null);
		};
	} else T = function() {
		g(w, 0);
	};
	function oe(e) {
		S = e, ee || (ee = !0, T());
	}
	function se(t, n) {
		te = g(function() {
			t(e.unstable_now());
		}, n);
	}
	e.unstable_IdlePriority = 5, e.unstable_ImmediatePriority = 1, e.unstable_LowPriority = 4, e.unstable_NormalPriority = 3, e.unstable_Profiling = null, e.unstable_UserBlockingPriority = 2, e.unstable_cancelCallback = function(e) {
		e.callback = null;
	}, e.unstable_continueExecution = function() {
		m || p || (m = !0, oe(x));
	}, e.unstable_forceFrameRate = function(e) {
		0 > e || 125 < e ? console.error("forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported") : C = 0 < e ? Math.floor(1e3 / e) : 5;
	}, e.unstable_getCurrentPriorityLevel = function() {
		return f;
	}, e.unstable_getFirstCallbackNode = function() {
		return n(c);
	}, e.unstable_next = function(e) {
		switch (f) {
			case 1:
			case 2:
			case 3:
				var t = 3;
				break;
			default: t = f;
		}
		var n = f;
		f = t;
		try {
			return e();
		} finally {
			f = n;
		}
	}, e.unstable_pauseExecution = function() {}, e.unstable_requestPaint = function() {}, e.unstable_runWithPriority = function(e, t) {
		switch (e) {
			case 1:
			case 2:
			case 3:
			case 4:
			case 5: break;
			default: e = 3;
		}
		var n = f;
		f = e;
		try {
			return t();
		} finally {
			f = n;
		}
	}, e.unstable_scheduleCallback = function(r, i, a) {
		var o = e.unstable_now();
		switch (typeof a == "object" && a ? (a = a.delay, a = typeof a == "number" && 0 < a ? o + a : o) : a = o, r) {
			case 1:
				var s = -1;
				break;
			case 2:
				s = 250;
				break;
			case 5:
				s = 1073741823;
				break;
			case 4:
				s = 1e4;
				break;
			default: s = 5e3;
		}
		return s = a + s, r = {
			id: u++,
			callback: i,
			priorityLevel: r,
			startTime: a,
			expirationTime: s,
			sortIndex: -1
		}, a > o ? (r.sortIndex = a, t(l, r), n(c) === null && r === n(l) && (h ? (_(te), te = -1) : h = !0, se(b, a - o))) : (r.sortIndex = s, t(c, r), m || p || (m = !0, oe(x))), r;
	}, e.unstable_shouldYield = re, e.unstable_wrapCallback = function(e) {
		var t = f;
		return function() {
			var n = f;
			f = t;
			try {
				return e.apply(this, arguments);
			} finally {
				f = n;
			}
		};
	};
})), f = /* @__PURE__ */ o(((e, t) => {
	t.exports = d();
})), p = /* @__PURE__ */ o(((e) => {
	var t = u(), n = f();
	function r(e) {
		for (var t = "https://reactjs.org/docs/error-decoder.html?invariant=" + e, n = 1; n < arguments.length; n++) t += "&args[]=" + encodeURIComponent(arguments[n]);
		return "Minified React error #" + e + "; visit " + t + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
	}
	var i = /* @__PURE__ */ new Set(), a = {};
	function o(e, t) {
		s(e, t), s(e + "Capture", t);
	}
	function s(e, t) {
		for (a[e] = t, e = 0; e < t.length; e++) i.add(t[e]);
	}
	var c = !(typeof window > "u" || window.document === void 0 || window.document.createElement === void 0), l = Object.prototype.hasOwnProperty, d = /^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\-.0-9\u00B7\u0300-\u036F\u203F-\u2040]*$/, p = {}, m = {};
	function h(e) {
		return l.call(m, e) ? !0 : l.call(p, e) ? !1 : d.test(e) ? m[e] = !0 : (p[e] = !0, !1);
	}
	function g(e, t, n, r) {
		if (n !== null && n.type === 0) return !1;
		switch (typeof t) {
			case "function":
			case "symbol": return !0;
			case "boolean": return r ? !1 : n === null ? (e = e.toLowerCase().slice(0, 5), e !== "data-" && e !== "aria-") : !n.acceptsBooleans;
			default: return !1;
		}
	}
	function _(e, t, n, r) {
		if (t == null || g(e, t, n, r)) return !0;
		if (r) return !1;
		if (n !== null) switch (n.type) {
			case 3: return !t;
			case 4: return !1 === t;
			case 5: return isNaN(t);
			case 6: return isNaN(t) || 1 > t;
		}
		return !1;
	}
	function v(e, t, n, r, i, a, o) {
		this.acceptsBooleans = t === 2 || t === 3 || t === 4, this.attributeName = r, this.attributeNamespace = i, this.mustUseProperty = n, this.propertyName = e, this.type = t, this.sanitizeURL = a, this.removeEmptyString = o;
	}
	var y = {};
	"children dangerouslySetInnerHTML defaultValue defaultChecked innerHTML suppressContentEditableWarning suppressHydrationWarning style".split(" ").forEach(function(e) {
		y[e] = new v(e, 0, !1, e, null, !1, !1);
	}), [
		["acceptCharset", "accept-charset"],
		["className", "class"],
		["htmlFor", "for"],
		["httpEquiv", "http-equiv"]
	].forEach(function(e) {
		var t = e[0];
		y[t] = new v(t, 1, !1, e[1], null, !1, !1);
	}), [
		"contentEditable",
		"draggable",
		"spellCheck",
		"value"
	].forEach(function(e) {
		y[e] = new v(e, 2, !1, e.toLowerCase(), null, !1, !1);
	}), [
		"autoReverse",
		"externalResourcesRequired",
		"focusable",
		"preserveAlpha"
	].forEach(function(e) {
		y[e] = new v(e, 2, !1, e, null, !1, !1);
	}), "allowFullScreen async autoFocus autoPlay controls default defer disabled disablePictureInPicture disableRemotePlayback formNoValidate hidden loop noModule noValidate open playsInline readOnly required reversed scoped seamless itemScope".split(" ").forEach(function(e) {
		y[e] = new v(e, 3, !1, e.toLowerCase(), null, !1, !1);
	}), [
		"checked",
		"multiple",
		"muted",
		"selected"
	].forEach(function(e) {
		y[e] = new v(e, 3, !0, e, null, !1, !1);
	}), ["capture", "download"].forEach(function(e) {
		y[e] = new v(e, 4, !1, e, null, !1, !1);
	}), [
		"cols",
		"rows",
		"size",
		"span"
	].forEach(function(e) {
		y[e] = new v(e, 6, !1, e, null, !1, !1);
	}), ["rowSpan", "start"].forEach(function(e) {
		y[e] = new v(e, 5, !1, e.toLowerCase(), null, !1, !1);
	});
	var b = /[\-:]([a-z])/g;
	function x(e) {
		return e[1].toUpperCase();
	}
	"accent-height alignment-baseline arabic-form baseline-shift cap-height clip-path clip-rule color-interpolation color-interpolation-filters color-profile color-rendering dominant-baseline enable-background fill-opacity fill-rule flood-color flood-opacity font-family font-size font-size-adjust font-stretch font-style font-variant font-weight glyph-name glyph-orientation-horizontal glyph-orientation-vertical horiz-adv-x horiz-origin-x image-rendering letter-spacing lighting-color marker-end marker-mid marker-start overline-position overline-thickness paint-order panose-1 pointer-events rendering-intent shape-rendering stop-color stop-opacity strikethrough-position strikethrough-thickness stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-rendering underline-position underline-thickness unicode-bidi unicode-range units-per-em v-alphabetic v-hanging v-ideographic v-mathematical vector-effect vert-adv-y vert-origin-x vert-origin-y word-spacing writing-mode xmlns:xlink x-height".split(" ").forEach(function(e) {
		var t = e.replace(b, x);
		y[t] = new v(t, 1, !1, e, null, !1, !1);
	}), "xlink:actuate xlink:arcrole xlink:role xlink:show xlink:title xlink:type".split(" ").forEach(function(e) {
		var t = e.replace(b, x);
		y[t] = new v(t, 1, !1, e, "http://www.w3.org/1999/xlink", !1, !1);
	}), [
		"xml:base",
		"xml:lang",
		"xml:space"
	].forEach(function(e) {
		var t = e.replace(b, x);
		y[t] = new v(t, 1, !1, e, "http://www.w3.org/XML/1998/namespace", !1, !1);
	}), ["tabIndex", "crossOrigin"].forEach(function(e) {
		y[e] = new v(e, 1, !1, e.toLowerCase(), null, !1, !1);
	}), y.xlinkHref = new v("xlinkHref", 1, !1, "xlink:href", "http://www.w3.org/1999/xlink", !0, !1), [
		"src",
		"href",
		"action",
		"formAction"
	].forEach(function(e) {
		y[e] = new v(e, 1, !1, e.toLowerCase(), null, !0, !0);
	});
	function ee(e, t, n, r) {
		var i = y.hasOwnProperty(t) ? y[t] : null;
		(i === null ? r || !(2 < t.length) || t[0] !== "o" && t[0] !== "O" || t[1] !== "n" && t[1] !== "N" : i.type !== 0) && (_(t, n, i, r) && (n = null), r || i === null ? h(t) && (n === null ? e.removeAttribute(t) : e.setAttribute(t, "" + n)) : i.mustUseProperty ? e[i.propertyName] = n === null ? i.type === 3 ? !1 : "" : n : (t = i.attributeName, r = i.attributeNamespace, n === null ? e.removeAttribute(t) : (i = i.type, n = i === 3 || i === 4 && !0 === n ? "" : "" + n, r ? e.setAttributeNS(r, t, n) : e.setAttribute(t, n))));
	}
	var S = t.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED, te = Symbol.for("react.element"), C = Symbol.for("react.portal"), ne = Symbol.for("react.fragment"), re = Symbol.for("react.strict_mode"), w = Symbol.for("react.profiler"), T = Symbol.for("react.provider"), ie = Symbol.for("react.context"), ae = Symbol.for("react.forward_ref"), oe = Symbol.for("react.suspense"), se = Symbol.for("react.suspense_list"), E = Symbol.for("react.memo"), D = Symbol.for("react.lazy"), ce = Symbol.for("react.offscreen"), O = Symbol.iterator;
	function le(e) {
		return typeof e != "object" || !e ? null : (e = O && e[O] || e["@@iterator"], typeof e == "function" ? e : null);
	}
	var k = Object.assign, ue;
	function de(e) {
		if (ue === void 0) try {
			throw Error();
		} catch (e) {
			var t = e.stack.trim().match(/\n( *(at )?)/);
			ue = t && t[1] || "";
		}
		return "\n" + ue + e;
	}
	var fe = !1;
	function pe(e, t) {
		if (!e || fe) return "";
		fe = !0;
		var n = Error.prepareStackTrace;
		Error.prepareStackTrace = void 0;
		try {
			if (t) if (t = function() {
				throw Error();
			}, Object.defineProperty(t.prototype, "props", { set: function() {
				throw Error();
			} }), typeof Reflect == "object" && Reflect.construct) {
				try {
					Reflect.construct(t, []);
				} catch (e) {
					var r = e;
				}
				Reflect.construct(e, [], t);
			} else {
				try {
					t.call();
				} catch (e) {
					r = e;
				}
				e.call(t.prototype);
			}
			else {
				try {
					throw Error();
				} catch (e) {
					r = e;
				}
				e();
			}
		} catch (t) {
			if (t && r && typeof t.stack == "string") {
				for (var i = t.stack.split("\n"), a = r.stack.split("\n"), o = i.length - 1, s = a.length - 1; 1 <= o && 0 <= s && i[o] !== a[s];) s--;
				for (; 1 <= o && 0 <= s; o--, s--) if (i[o] !== a[s]) {
					if (o !== 1 || s !== 1) do
						if (o--, s--, 0 > s || i[o] !== a[s]) {
							var c = "\n" + i[o].replace(" at new ", " at ");
							return e.displayName && c.includes("<anonymous>") && (c = c.replace("<anonymous>", e.displayName)), c;
						}
					while (1 <= o && 0 <= s);
					break;
				}
			}
		} finally {
			fe = !1, Error.prepareStackTrace = n;
		}
		return (e = e ? e.displayName || e.name : "") ? de(e) : "";
	}
	function me(e) {
		switch (e.tag) {
			case 5: return de(e.type);
			case 16: return de("Lazy");
			case 13: return de("Suspense");
			case 19: return de("SuspenseList");
			case 0:
			case 2:
			case 15: return e = pe(e.type, !1), e;
			case 11: return e = pe(e.type.render, !1), e;
			case 1: return e = pe(e.type, !0), e;
			default: return "";
		}
	}
	function he(e) {
		if (e == null) return null;
		if (typeof e == "function") return e.displayName || e.name || null;
		if (typeof e == "string") return e;
		switch (e) {
			case ne: return "Fragment";
			case C: return "Portal";
			case w: return "Profiler";
			case re: return "StrictMode";
			case oe: return "Suspense";
			case se: return "SuspenseList";
		}
		if (typeof e == "object") switch (e.$$typeof) {
			case ie: return (e.displayName || "Context") + ".Consumer";
			case T: return (e._context.displayName || "Context") + ".Provider";
			case ae:
				var t = e.render;
				return e = e.displayName, e ||= (e = t.displayName || t.name || "", e === "" ? "ForwardRef" : "ForwardRef(" + e + ")"), e;
			case E: return t = e.displayName || null, t === null ? he(e.type) || "Memo" : t;
			case D:
				t = e._payload, e = e._init;
				try {
					return he(e(t));
				} catch {}
		}
		return null;
	}
	function ge(e) {
		var t = e.type;
		switch (e.tag) {
			case 24: return "Cache";
			case 9: return (t.displayName || "Context") + ".Consumer";
			case 10: return (t._context.displayName || "Context") + ".Provider";
			case 18: return "DehydratedFragment";
			case 11: return e = t.render, e = e.displayName || e.name || "", t.displayName || (e === "" ? "ForwardRef" : "ForwardRef(" + e + ")");
			case 7: return "Fragment";
			case 5: return t;
			case 4: return "Portal";
			case 3: return "Root";
			case 6: return "Text";
			case 16: return he(t);
			case 8: return t === re ? "StrictMode" : "Mode";
			case 22: return "Offscreen";
			case 12: return "Profiler";
			case 21: return "Scope";
			case 13: return "Suspense";
			case 19: return "SuspenseList";
			case 25: return "TracingMarker";
			case 1:
			case 0:
			case 17:
			case 2:
			case 14:
			case 15:
				if (typeof t == "function") return t.displayName || t.name || null;
				if (typeof t == "string") return t;
		}
		return null;
	}
	function A(e) {
		switch (typeof e) {
			case "boolean":
			case "number":
			case "string":
			case "undefined": return e;
			case "object": return e;
			default: return "";
		}
	}
	function _e(e) {
		var t = e.type;
		return (e = e.nodeName) && e.toLowerCase() === "input" && (t === "checkbox" || t === "radio");
	}
	function ve(e) {
		var t = _e(e) ? "checked" : "value", n = Object.getOwnPropertyDescriptor(e.constructor.prototype, t), r = "" + e[t];
		if (!e.hasOwnProperty(t) && n !== void 0 && typeof n.get == "function" && typeof n.set == "function") {
			var i = n.get, a = n.set;
			return Object.defineProperty(e, t, {
				configurable: !0,
				get: function() {
					return i.call(this);
				},
				set: function(e) {
					r = "" + e, a.call(this, e);
				}
			}), Object.defineProperty(e, t, { enumerable: n.enumerable }), {
				getValue: function() {
					return r;
				},
				setValue: function(e) {
					r = "" + e;
				},
				stopTracking: function() {
					e._valueTracker = null, delete e[t];
				}
			};
		}
	}
	function ye(e) {
		e._valueTracker ||= ve(e);
	}
	function j(e) {
		if (!e) return !1;
		var t = e._valueTracker;
		if (!t) return !0;
		var n = t.getValue(), r = "";
		return e && (r = _e(e) ? e.checked ? "true" : "false" : e.value), e = r, e === n ? !1 : (t.setValue(e), !0);
	}
	function be(e) {
		if (e ||= typeof document < "u" ? document : void 0, e === void 0) return null;
		try {
			return e.activeElement || e.body;
		} catch {
			return e.body;
		}
	}
	function xe(e, t) {
		var n = t.checked;
		return k({}, t, {
			defaultChecked: void 0,
			defaultValue: void 0,
			value: void 0,
			checked: n ?? e._wrapperState.initialChecked
		});
	}
	function Se(e, t) {
		var n = t.defaultValue == null ? "" : t.defaultValue, r = t.checked == null ? t.defaultChecked : t.checked;
		n = A(t.value == null ? n : t.value), e._wrapperState = {
			initialChecked: r,
			initialValue: n,
			controlled: t.type === "checkbox" || t.type === "radio" ? t.checked != null : t.value != null
		};
	}
	function Ce(e, t) {
		t = t.checked, t != null && ee(e, "checked", t, !1);
	}
	function we(e, t) {
		Ce(e, t);
		var n = A(t.value), r = t.type;
		if (n != null) r === "number" ? (n === 0 && e.value === "" || e.value != n) && (e.value = "" + n) : e.value !== "" + n && (e.value = "" + n);
		else if (r === "submit" || r === "reset") {
			e.removeAttribute("value");
			return;
		}
		t.hasOwnProperty("value") ? Ee(e, t.type, n) : t.hasOwnProperty("defaultValue") && Ee(e, t.type, A(t.defaultValue)), t.checked == null && t.defaultChecked != null && (e.defaultChecked = !!t.defaultChecked);
	}
	function Te(e, t, n) {
		if (t.hasOwnProperty("value") || t.hasOwnProperty("defaultValue")) {
			var r = t.type;
			if (!(r !== "submit" && r !== "reset" || t.value !== void 0 && t.value !== null)) return;
			t = "" + e._wrapperState.initialValue, n || t === e.value || (e.value = t), e.defaultValue = t;
		}
		n = e.name, n !== "" && (e.name = ""), e.defaultChecked = !!e._wrapperState.initialChecked, n !== "" && (e.name = n);
	}
	function Ee(e, t, n) {
		(t !== "number" || be(e.ownerDocument) !== e) && (n == null ? e.defaultValue = "" + e._wrapperState.initialValue : e.defaultValue !== "" + n && (e.defaultValue = "" + n));
	}
	var De = Array.isArray;
	function Oe(e, t, n, r) {
		if (e = e.options, t) {
			t = {};
			for (var i = 0; i < n.length; i++) t["$" + n[i]] = !0;
			for (n = 0; n < e.length; n++) i = t.hasOwnProperty("$" + e[n].value), e[n].selected !== i && (e[n].selected = i), i && r && (e[n].defaultSelected = !0);
		} else {
			for (n = "" + A(n), t = null, i = 0; i < e.length; i++) {
				if (e[i].value === n) {
					e[i].selected = !0, r && (e[i].defaultSelected = !0);
					return;
				}
				t !== null || e[i].disabled || (t = e[i]);
			}
			t !== null && (t.selected = !0);
		}
	}
	function ke(e, t) {
		if (t.dangerouslySetInnerHTML != null) throw Error(r(91));
		return k({}, t, {
			value: void 0,
			defaultValue: void 0,
			children: "" + e._wrapperState.initialValue
		});
	}
	function Ae(e, t) {
		var n = t.value;
		if (n == null) {
			if (n = t.children, t = t.defaultValue, n != null) {
				if (t != null) throw Error(r(92));
				if (De(n)) {
					if (1 < n.length) throw Error(r(93));
					n = n[0];
				}
				t = n;
			}
			t ??= "", n = t;
		}
		e._wrapperState = { initialValue: A(n) };
	}
	function je(e, t) {
		var n = A(t.value), r = A(t.defaultValue);
		n != null && (n = "" + n, n !== e.value && (e.value = n), t.defaultValue == null && e.defaultValue !== n && (e.defaultValue = n)), r != null && (e.defaultValue = "" + r);
	}
	function Me(e) {
		var t = e.textContent;
		t === e._wrapperState.initialValue && t !== "" && t !== null && (e.value = t);
	}
	function Ne(e) {
		switch (e) {
			case "svg": return "http://www.w3.org/2000/svg";
			case "math": return "http://www.w3.org/1998/Math/MathML";
			default: return "http://www.w3.org/1999/xhtml";
		}
	}
	function Pe(e, t) {
		return e == null || e === "http://www.w3.org/1999/xhtml" ? Ne(t) : e === "http://www.w3.org/2000/svg" && t === "foreignObject" ? "http://www.w3.org/1999/xhtml" : e;
	}
	var Fe, Ie = function(e) {
		return typeof MSApp < "u" && MSApp.execUnsafeLocalFunction ? function(t, n, r, i) {
			MSApp.execUnsafeLocalFunction(function() {
				return e(t, n, r, i);
			});
		} : e;
	}(function(e, t) {
		if (e.namespaceURI !== "http://www.w3.org/2000/svg" || "innerHTML" in e) e.innerHTML = t;
		else {
			for (Fe ||= document.createElement("div"), Fe.innerHTML = "<svg>" + t.valueOf().toString() + "</svg>", t = Fe.firstChild; e.firstChild;) e.removeChild(e.firstChild);
			for (; t.firstChild;) e.appendChild(t.firstChild);
		}
	});
	function Le(e, t) {
		if (t) {
			var n = e.firstChild;
			if (n && n === e.lastChild && n.nodeType === 3) {
				n.nodeValue = t;
				return;
			}
		}
		e.textContent = t;
	}
	var Re = {
		animationIterationCount: !0,
		aspectRatio: !0,
		borderImageOutset: !0,
		borderImageSlice: !0,
		borderImageWidth: !0,
		boxFlex: !0,
		boxFlexGroup: !0,
		boxOrdinalGroup: !0,
		columnCount: !0,
		columns: !0,
		flex: !0,
		flexGrow: !0,
		flexPositive: !0,
		flexShrink: !0,
		flexNegative: !0,
		flexOrder: !0,
		gridArea: !0,
		gridRow: !0,
		gridRowEnd: !0,
		gridRowSpan: !0,
		gridRowStart: !0,
		gridColumn: !0,
		gridColumnEnd: !0,
		gridColumnSpan: !0,
		gridColumnStart: !0,
		fontWeight: !0,
		lineClamp: !0,
		lineHeight: !0,
		opacity: !0,
		order: !0,
		orphans: !0,
		tabSize: !0,
		widows: !0,
		zIndex: !0,
		zoom: !0,
		fillOpacity: !0,
		floodOpacity: !0,
		stopOpacity: !0,
		strokeDasharray: !0,
		strokeDashoffset: !0,
		strokeMiterlimit: !0,
		strokeOpacity: !0,
		strokeWidth: !0
	}, ze = [
		"Webkit",
		"ms",
		"Moz",
		"O"
	];
	Object.keys(Re).forEach(function(e) {
		ze.forEach(function(t) {
			t = t + e.charAt(0).toUpperCase() + e.substring(1), Re[t] = Re[e];
		});
	});
	function Be(e, t, n) {
		return t == null || typeof t == "boolean" || t === "" ? "" : n || typeof t != "number" || t === 0 || Re.hasOwnProperty(e) && Re[e] ? ("" + t).trim() : t + "px";
	}
	function Ve(e, t) {
		for (var n in e = e.style, t) if (t.hasOwnProperty(n)) {
			var r = n.indexOf("--") === 0, i = Be(n, t[n], r);
			n === "float" && (n = "cssFloat"), r ? e.setProperty(n, i) : e[n] = i;
		}
	}
	var He = k({ menuitem: !0 }, {
		area: !0,
		base: !0,
		br: !0,
		col: !0,
		embed: !0,
		hr: !0,
		img: !0,
		input: !0,
		keygen: !0,
		link: !0,
		meta: !0,
		param: !0,
		source: !0,
		track: !0,
		wbr: !0
	});
	function Ue(e, t) {
		if (t) {
			if (He[e] && (t.children != null || t.dangerouslySetInnerHTML != null)) throw Error(r(137, e));
			if (t.dangerouslySetInnerHTML != null) {
				if (t.children != null) throw Error(r(60));
				if (typeof t.dangerouslySetInnerHTML != "object" || !("__html" in t.dangerouslySetInnerHTML)) throw Error(r(61));
			}
			if (t.style != null && typeof t.style != "object") throw Error(r(62));
		}
	}
	function We(e, t) {
		if (e.indexOf("-") === -1) return typeof t.is == "string";
		switch (e) {
			case "annotation-xml":
			case "color-profile":
			case "font-face":
			case "font-face-src":
			case "font-face-uri":
			case "font-face-format":
			case "font-face-name":
			case "missing-glyph": return !1;
			default: return !0;
		}
	}
	var Ge = null;
	function Ke(e) {
		return e = e.target || e.srcElement || window, e.correspondingUseElement && (e = e.correspondingUseElement), e.nodeType === 3 ? e.parentNode : e;
	}
	var qe = null, Je = null, Ye = null;
	function Xe(e) {
		if (e = Ji(e)) {
			if (typeof qe != "function") throw Error(r(280));
			var t = e.stateNode;
			t && (t = Xi(t), qe(e.stateNode, e.type, t));
		}
	}
	function Ze(e) {
		Je ? Ye ? Ye.push(e) : Ye = [e] : Je = e;
	}
	function Qe() {
		if (Je) {
			var e = Je, t = Ye;
			if (Ye = Je = null, Xe(e), t) for (e = 0; e < t.length; e++) Xe(t[e]);
		}
	}
	function $e(e, t) {
		return e(t);
	}
	function et() {}
	var tt = !1;
	function nt(e, t, n) {
		if (tt) return e(t, n);
		tt = !0;
		try {
			return $e(e, t, n);
		} finally {
			tt = !1, (Je !== null || Ye !== null) && (et(), Qe());
		}
	}
	function rt(e, t) {
		var n = e.stateNode;
		if (n === null) return null;
		var i = Xi(n);
		if (i === null) return null;
		n = i[t];
		a: switch (t) {
			case "onClick":
			case "onClickCapture":
			case "onDoubleClick":
			case "onDoubleClickCapture":
			case "onMouseDown":
			case "onMouseDownCapture":
			case "onMouseMove":
			case "onMouseMoveCapture":
			case "onMouseUp":
			case "onMouseUpCapture":
			case "onMouseEnter":
				(i = !i.disabled) || (e = e.type, i = !(e === "button" || e === "input" || e === "select" || e === "textarea")), e = !i;
				break a;
			default: e = !1;
		}
		if (e) return null;
		if (n && typeof n != "function") throw Error(r(231, t, typeof n));
		return n;
	}
	var it = !1;
	if (c) try {
		var at = {};
		Object.defineProperty(at, "passive", { get: function() {
			it = !0;
		} }), window.addEventListener("test", at, at), window.removeEventListener("test", at, at);
	} catch {
		it = !1;
	}
	function ot(e, t, n, r, i, a, o, s, c) {
		var l = Array.prototype.slice.call(arguments, 3);
		try {
			t.apply(n, l);
		} catch (e) {
			this.onError(e);
		}
	}
	var st = !1, ct = null, lt = !1, ut = null, dt = { onError: function(e) {
		st = !0, ct = e;
	} };
	function ft(e, t, n, r, i, a, o, s, c) {
		st = !1, ct = null, ot.apply(dt, arguments);
	}
	function pt(e, t, n, i, a, o, s, c, l) {
		if (ft.apply(this, arguments), st) {
			if (st) {
				var u = ct;
				st = !1, ct = null;
			} else throw Error(r(198));
			lt || (lt = !0, ut = u);
		}
	}
	function mt(e) {
		var t = e, n = e;
		if (e.alternate) for (; t.return;) t = t.return;
		else {
			e = t;
			do
				t = e, t.flags & 4098 && (n = t.return), e = t.return;
			while (e);
		}
		return t.tag === 3 ? n : null;
	}
	function ht(e) {
		if (e.tag === 13) {
			var t = e.memoizedState;
			if (t === null && (e = e.alternate, e !== null && (t = e.memoizedState)), t !== null) return t.dehydrated;
		}
		return null;
	}
	function gt(e) {
		if (mt(e) !== e) throw Error(r(188));
	}
	function _t(e) {
		var t = e.alternate;
		if (!t) {
			if (t = mt(e), t === null) throw Error(r(188));
			return t === e ? e : null;
		}
		for (var n = e, i = t;;) {
			var a = n.return;
			if (a === null) break;
			var o = a.alternate;
			if (o === null) {
				if (i = a.return, i !== null) {
					n = i;
					continue;
				}
				break;
			}
			if (a.child === o.child) {
				for (o = a.child; o;) {
					if (o === n) return gt(a), e;
					if (o === i) return gt(a), t;
					o = o.sibling;
				}
				throw Error(r(188));
			}
			if (n.return !== i.return) n = a, i = o;
			else {
				for (var s = !1, c = a.child; c;) {
					if (c === n) {
						s = !0, n = a, i = o;
						break;
					}
					if (c === i) {
						s = !0, i = a, n = o;
						break;
					}
					c = c.sibling;
				}
				if (!s) {
					for (c = o.child; c;) {
						if (c === n) {
							s = !0, n = o, i = a;
							break;
						}
						if (c === i) {
							s = !0, i = o, n = a;
							break;
						}
						c = c.sibling;
					}
					if (!s) throw Error(r(189));
				}
			}
			if (n.alternate !== i) throw Error(r(190));
		}
		if (n.tag !== 3) throw Error(r(188));
		return n.stateNode.current === n ? e : t;
	}
	function vt(e) {
		return e = _t(e), e === null ? null : yt(e);
	}
	function yt(e) {
		if (e.tag === 5 || e.tag === 6) return e;
		for (e = e.child; e !== null;) {
			var t = yt(e);
			if (t !== null) return t;
			e = e.sibling;
		}
		return null;
	}
	var bt = n.unstable_scheduleCallback, xt = n.unstable_cancelCallback, St = n.unstable_shouldYield, Ct = n.unstable_requestPaint, M = n.unstable_now, wt = n.unstable_getCurrentPriorityLevel, Tt = n.unstable_ImmediatePriority, Et = n.unstable_UserBlockingPriority, Dt = n.unstable_NormalPriority, Ot = n.unstable_LowPriority, kt = n.unstable_IdlePriority, At = null, jt = null;
	function Mt(e) {
		if (jt && typeof jt.onCommitFiberRoot == "function") try {
			jt.onCommitFiberRoot(At, e, void 0, (e.current.flags & 128) == 128);
		} catch {}
	}
	var Nt = Math.clz32 ? Math.clz32 : It, Pt = Math.log, Ft = Math.LN2;
	function It(e) {
		return e >>>= 0, e === 0 ? 32 : 31 - (Pt(e) / Ft | 0) | 0;
	}
	var Lt = 64, Rt = 4194304;
	function zt(e) {
		switch (e & -e) {
			case 1: return 1;
			case 2: return 2;
			case 4: return 4;
			case 8: return 8;
			case 16: return 16;
			case 32: return 32;
			case 64:
			case 128:
			case 256:
			case 512:
			case 1024:
			case 2048:
			case 4096:
			case 8192:
			case 16384:
			case 32768:
			case 65536:
			case 131072:
			case 262144:
			case 524288:
			case 1048576:
			case 2097152: return e & 4194240;
			case 4194304:
			case 8388608:
			case 16777216:
			case 33554432:
			case 67108864: return e & 130023424;
			case 134217728: return 134217728;
			case 268435456: return 268435456;
			case 536870912: return 536870912;
			case 1073741824: return 1073741824;
			default: return e;
		}
	}
	function Bt(e, t) {
		var n = e.pendingLanes;
		if (n === 0) return 0;
		var r = 0, i = e.suspendedLanes, a = e.pingedLanes, o = n & 268435455;
		if (o !== 0) {
			var s = o & ~i;
			s === 0 ? (a &= o, a !== 0 && (r = zt(a))) : r = zt(s);
		} else o = n & ~i, o === 0 ? a !== 0 && (r = zt(a)) : r = zt(o);
		if (r === 0) return 0;
		if (t !== 0 && t !== r && (t & i) === 0 && (i = r & -r, a = t & -t, i >= a || i === 16 && a & 4194240)) return t;
		if (r & 4 && (r |= n & 16), t = e.entangledLanes, t !== 0) for (e = e.entanglements, t &= r; 0 < t;) n = 31 - Nt(t), i = 1 << n, r |= e[n], t &= ~i;
		return r;
	}
	function Vt(e, t) {
		switch (e) {
			case 1:
			case 2:
			case 4: return t + 250;
			case 8:
			case 16:
			case 32:
			case 64:
			case 128:
			case 256:
			case 512:
			case 1024:
			case 2048:
			case 4096:
			case 8192:
			case 16384:
			case 32768:
			case 65536:
			case 131072:
			case 262144:
			case 524288:
			case 1048576:
			case 2097152: return t + 5e3;
			case 4194304:
			case 8388608:
			case 16777216:
			case 33554432:
			case 67108864: return -1;
			case 134217728:
			case 268435456:
			case 536870912:
			case 1073741824: return -1;
			default: return -1;
		}
	}
	function Ht(e, t) {
		for (var n = e.suspendedLanes, r = e.pingedLanes, i = e.expirationTimes, a = e.pendingLanes; 0 < a;) {
			var o = 31 - Nt(a), s = 1 << o, c = i[o];
			c === -1 ? ((s & n) === 0 || (s & r) !== 0) && (i[o] = Vt(s, t)) : c <= t && (e.expiredLanes |= s), a &= ~s;
		}
	}
	function Ut(e) {
		return e = e.pendingLanes & -1073741825, e === 0 ? e & 1073741824 ? 1073741824 : 0 : e;
	}
	function Wt() {
		var e = Lt;
		return Lt <<= 1, !(Lt & 4194240) && (Lt = 64), e;
	}
	function Gt(e) {
		for (var t = [], n = 0; 31 > n; n++) t.push(e);
		return t;
	}
	function Kt(e, t, n) {
		e.pendingLanes |= t, t !== 536870912 && (e.suspendedLanes = 0, e.pingedLanes = 0), e = e.eventTimes, t = 31 - Nt(t), e[t] = n;
	}
	function qt(e, t) {
		var n = e.pendingLanes & ~t;
		e.pendingLanes = t, e.suspendedLanes = 0, e.pingedLanes = 0, e.expiredLanes &= t, e.mutableReadLanes &= t, e.entangledLanes &= t, t = e.entanglements;
		var r = e.eventTimes;
		for (e = e.expirationTimes; 0 < n;) {
			var i = 31 - Nt(n), a = 1 << i;
			t[i] = 0, r[i] = -1, e[i] = -1, n &= ~a;
		}
	}
	function Jt(e, t) {
		var n = e.entangledLanes |= t;
		for (e = e.entanglements; n;) {
			var r = 31 - Nt(n), i = 1 << r;
			i & t | e[r] & t && (e[r] |= t), n &= ~i;
		}
	}
	var N = 0;
	function Yt(e) {
		return e &= -e, 1 < e ? 4 < e ? e & 268435455 ? 16 : 536870912 : 4 : 1;
	}
	var Xt, Zt, Qt, $t, en, tn = !1, nn = [], rn = null, an = null, on = null, sn = /* @__PURE__ */ new Map(), cn = /* @__PURE__ */ new Map(), ln = [], un = "mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset submit".split(" ");
	function dn(e, t) {
		switch (e) {
			case "focusin":
			case "focusout":
				rn = null;
				break;
			case "dragenter":
			case "dragleave":
				an = null;
				break;
			case "mouseover":
			case "mouseout":
				on = null;
				break;
			case "pointerover":
			case "pointerout":
				sn.delete(t.pointerId);
				break;
			case "gotpointercapture":
			case "lostpointercapture": cn.delete(t.pointerId);
		}
	}
	function fn(e, t, n, r, i, a) {
		return e === null || e.nativeEvent !== a ? (e = {
			blockedOn: t,
			domEventName: n,
			eventSystemFlags: r,
			nativeEvent: a,
			targetContainers: [i]
		}, t !== null && (t = Ji(t), t !== null && Zt(t)), e) : (e.eventSystemFlags |= r, t = e.targetContainers, i !== null && t.indexOf(i) === -1 && t.push(i), e);
	}
	function pn(e, t, n, r, i) {
		switch (t) {
			case "focusin": return rn = fn(rn, e, t, n, r, i), !0;
			case "dragenter": return an = fn(an, e, t, n, r, i), !0;
			case "mouseover": return on = fn(on, e, t, n, r, i), !0;
			case "pointerover":
				var a = i.pointerId;
				return sn.set(a, fn(sn.get(a) || null, e, t, n, r, i)), !0;
			case "gotpointercapture": return a = i.pointerId, cn.set(a, fn(cn.get(a) || null, e, t, n, r, i)), !0;
		}
		return !1;
	}
	function mn(e) {
		var t = qi(e.target);
		if (t !== null) {
			var n = mt(t);
			if (n !== null) {
				if (t = n.tag, t === 13) {
					if (t = ht(n), t !== null) {
						e.blockedOn = t, en(e.priority, function() {
							Qt(n);
						});
						return;
					}
				} else if (t === 3 && n.stateNode.current.memoizedState.isDehydrated) {
					e.blockedOn = n.tag === 3 ? n.stateNode.containerInfo : null;
					return;
				}
			}
		}
		e.blockedOn = null;
	}
	function hn(e) {
		if (e.blockedOn !== null) return !1;
		for (var t = e.targetContainers; 0 < t.length;) {
			var n = En(e.domEventName, e.eventSystemFlags, t[0], e.nativeEvent);
			if (n === null) {
				n = e.nativeEvent;
				var r = new n.constructor(n.type, n);
				Ge = r, n.target.dispatchEvent(r), Ge = null;
			} else return t = Ji(n), t !== null && Zt(t), e.blockedOn = n, !1;
			t.shift();
		}
		return !0;
	}
	function gn(e, t, n) {
		hn(e) && n.delete(t);
	}
	function _n() {
		tn = !1, rn !== null && hn(rn) && (rn = null), an !== null && hn(an) && (an = null), on !== null && hn(on) && (on = null), sn.forEach(gn), cn.forEach(gn);
	}
	function vn(e, t) {
		e.blockedOn === t && (e.blockedOn = null, tn || (tn = !0, n.unstable_scheduleCallback(n.unstable_NormalPriority, _n)));
	}
	function yn(e) {
		function t(t) {
			return vn(t, e);
		}
		if (0 < nn.length) {
			vn(nn[0], e);
			for (var n = 1; n < nn.length; n++) {
				var r = nn[n];
				r.blockedOn === e && (r.blockedOn = null);
			}
		}
		for (rn !== null && vn(rn, e), an !== null && vn(an, e), on !== null && vn(on, e), sn.forEach(t), cn.forEach(t), n = 0; n < ln.length; n++) r = ln[n], r.blockedOn === e && (r.blockedOn = null);
		for (; 0 < ln.length && (n = ln[0], n.blockedOn === null);) mn(n), n.blockedOn === null && ln.shift();
	}
	var bn = S.ReactCurrentBatchConfig, xn = !0;
	function Sn(e, t, n, r) {
		var i = N, a = bn.transition;
		bn.transition = null;
		try {
			N = 1, wn(e, t, n, r);
		} finally {
			N = i, bn.transition = a;
		}
	}
	function Cn(e, t, n, r) {
		var i = N, a = bn.transition;
		bn.transition = null;
		try {
			N = 4, wn(e, t, n, r);
		} finally {
			N = i, bn.transition = a;
		}
	}
	function wn(e, t, n, r) {
		if (xn) {
			var i = En(e, t, n, r);
			if (i === null) yi(e, t, r, Tn, n), dn(e, r);
			else if (pn(i, e, t, n, r)) r.stopPropagation();
			else if (dn(e, r), t & 4 && -1 < un.indexOf(e)) {
				for (; i !== null;) {
					var a = Ji(i);
					if (a !== null && Xt(a), a = En(e, t, n, r), a === null && yi(e, t, r, Tn, n), a === i) break;
					i = a;
				}
				i !== null && r.stopPropagation();
			} else yi(e, t, r, null, n);
		}
	}
	var Tn = null;
	function En(e, t, n, r) {
		if (Tn = null, e = Ke(r), e = qi(e), e !== null) if (t = mt(e), t === null) e = null;
		else if (n = t.tag, n === 13) {
			if (e = ht(t), e !== null) return e;
			e = null;
		} else if (n === 3) {
			if (t.stateNode.current.memoizedState.isDehydrated) return t.tag === 3 ? t.stateNode.containerInfo : null;
			e = null;
		} else t !== e && (e = null);
		return Tn = e, null;
	}
	function Dn(e) {
		switch (e) {
			case "cancel":
			case "click":
			case "close":
			case "contextmenu":
			case "copy":
			case "cut":
			case "auxclick":
			case "dblclick":
			case "dragend":
			case "dragstart":
			case "drop":
			case "focusin":
			case "focusout":
			case "input":
			case "invalid":
			case "keydown":
			case "keypress":
			case "keyup":
			case "mousedown":
			case "mouseup":
			case "paste":
			case "pause":
			case "play":
			case "pointercancel":
			case "pointerdown":
			case "pointerup":
			case "ratechange":
			case "reset":
			case "resize":
			case "seeked":
			case "submit":
			case "touchcancel":
			case "touchend":
			case "touchstart":
			case "volumechange":
			case "change":
			case "selectionchange":
			case "textInput":
			case "compositionstart":
			case "compositionend":
			case "compositionupdate":
			case "beforeblur":
			case "afterblur":
			case "beforeinput":
			case "blur":
			case "fullscreenchange":
			case "focus":
			case "hashchange":
			case "popstate":
			case "select":
			case "selectstart": return 1;
			case "drag":
			case "dragenter":
			case "dragexit":
			case "dragleave":
			case "dragover":
			case "mousemove":
			case "mouseout":
			case "mouseover":
			case "pointermove":
			case "pointerout":
			case "pointerover":
			case "scroll":
			case "toggle":
			case "touchmove":
			case "wheel":
			case "mouseenter":
			case "mouseleave":
			case "pointerenter":
			case "pointerleave": return 4;
			case "message": switch (wt()) {
				case Tt: return 1;
				case Et: return 4;
				case Dt:
				case Ot: return 16;
				case kt: return 536870912;
				default: return 16;
			}
			default: return 16;
		}
	}
	var On = null, kn = null, An = null;
	function jn() {
		if (An) return An;
		var e, t = kn, n = t.length, r, i = "value" in On ? On.value : On.textContent, a = i.length;
		for (e = 0; e < n && t[e] === i[e]; e++);
		var o = n - e;
		for (r = 1; r <= o && t[n - r] === i[a - r]; r++);
		return An = i.slice(e, 1 < r ? 1 - r : void 0);
	}
	function Mn(e) {
		var t = e.keyCode;
		return "charCode" in e ? (e = e.charCode, e === 0 && t === 13 && (e = 13)) : e = t, e === 10 && (e = 13), 32 <= e || e === 13 ? e : 0;
	}
	function Nn() {
		return !0;
	}
	function Pn() {
		return !1;
	}
	function Fn(e) {
		function t(t, n, r, i, a) {
			for (var o in this._reactName = t, this._targetInst = r, this.type = n, this.nativeEvent = i, this.target = a, this.currentTarget = null, e) e.hasOwnProperty(o) && (t = e[o], this[o] = t ? t(i) : i[o]);
			return this.isDefaultPrevented = (i.defaultPrevented == null ? !1 === i.returnValue : i.defaultPrevented) ? Nn : Pn, this.isPropagationStopped = Pn, this;
		}
		return k(t.prototype, {
			preventDefault: function() {
				this.defaultPrevented = !0;
				var e = this.nativeEvent;
				e && (e.preventDefault ? e.preventDefault() : typeof e.returnValue != "unknown" && (e.returnValue = !1), this.isDefaultPrevented = Nn);
			},
			stopPropagation: function() {
				var e = this.nativeEvent;
				e && (e.stopPropagation ? e.stopPropagation() : typeof e.cancelBubble != "unknown" && (e.cancelBubble = !0), this.isPropagationStopped = Nn);
			},
			persist: function() {},
			isPersistent: Nn
		}), t;
	}
	var In = {
		eventPhase: 0,
		bubbles: 0,
		cancelable: 0,
		timeStamp: function(e) {
			return e.timeStamp || Date.now();
		},
		defaultPrevented: 0,
		isTrusted: 0
	}, Ln = Fn(In), Rn = k({}, In, {
		view: 0,
		detail: 0
	}), zn = Fn(Rn), Bn, Vn, Hn, Un = k({}, Rn, {
		screenX: 0,
		screenY: 0,
		clientX: 0,
		clientY: 0,
		pageX: 0,
		pageY: 0,
		ctrlKey: 0,
		shiftKey: 0,
		altKey: 0,
		metaKey: 0,
		getModifierState: er,
		button: 0,
		buttons: 0,
		relatedTarget: function(e) {
			return e.relatedTarget === void 0 ? e.fromElement === e.srcElement ? e.toElement : e.fromElement : e.relatedTarget;
		},
		movementX: function(e) {
			return "movementX" in e ? e.movementX : (e !== Hn && (Hn && e.type === "mousemove" ? (Bn = e.screenX - Hn.screenX, Vn = e.screenY - Hn.screenY) : Vn = Bn = 0, Hn = e), Bn);
		},
		movementY: function(e) {
			return "movementY" in e ? e.movementY : Vn;
		}
	}), Wn = Fn(Un), Gn = Fn(k({}, Un, { dataTransfer: 0 })), Kn = Fn(k({}, Rn, { relatedTarget: 0 })), qn = Fn(k({}, In, {
		animationName: 0,
		elapsedTime: 0,
		pseudoElement: 0
	})), Jn = Fn(k({}, In, { clipboardData: function(e) {
		return "clipboardData" in e ? e.clipboardData : window.clipboardData;
	} })), Yn = Fn(k({}, In, { data: 0 })), Xn = {
		Esc: "Escape",
		Spacebar: " ",
		Left: "ArrowLeft",
		Up: "ArrowUp",
		Right: "ArrowRight",
		Down: "ArrowDown",
		Del: "Delete",
		Win: "OS",
		Menu: "ContextMenu",
		Apps: "ContextMenu",
		Scroll: "ScrollLock",
		MozPrintableKey: "Unidentified"
	}, Zn = {
		8: "Backspace",
		9: "Tab",
		12: "Clear",
		13: "Enter",
		16: "Shift",
		17: "Control",
		18: "Alt",
		19: "Pause",
		20: "CapsLock",
		27: "Escape",
		32: " ",
		33: "PageUp",
		34: "PageDown",
		35: "End",
		36: "Home",
		37: "ArrowLeft",
		38: "ArrowUp",
		39: "ArrowRight",
		40: "ArrowDown",
		45: "Insert",
		46: "Delete",
		112: "F1",
		113: "F2",
		114: "F3",
		115: "F4",
		116: "F5",
		117: "F6",
		118: "F7",
		119: "F8",
		120: "F9",
		121: "F10",
		122: "F11",
		123: "F12",
		144: "NumLock",
		145: "ScrollLock",
		224: "Meta"
	}, Qn = {
		Alt: "altKey",
		Control: "ctrlKey",
		Meta: "metaKey",
		Shift: "shiftKey"
	};
	function $n(e) {
		var t = this.nativeEvent;
		return t.getModifierState ? t.getModifierState(e) : (e = Qn[e]) ? !!t[e] : !1;
	}
	function er() {
		return $n;
	}
	var tr = Fn(k({}, Rn, {
		key: function(e) {
			if (e.key) {
				var t = Xn[e.key] || e.key;
				if (t !== "Unidentified") return t;
			}
			return e.type === "keypress" ? (e = Mn(e), e === 13 ? "Enter" : String.fromCharCode(e)) : e.type === "keydown" || e.type === "keyup" ? Zn[e.keyCode] || "Unidentified" : "";
		},
		code: 0,
		location: 0,
		ctrlKey: 0,
		shiftKey: 0,
		altKey: 0,
		metaKey: 0,
		repeat: 0,
		locale: 0,
		getModifierState: er,
		charCode: function(e) {
			return e.type === "keypress" ? Mn(e) : 0;
		},
		keyCode: function(e) {
			return e.type === "keydown" || e.type === "keyup" ? e.keyCode : 0;
		},
		which: function(e) {
			return e.type === "keypress" ? Mn(e) : e.type === "keydown" || e.type === "keyup" ? e.keyCode : 0;
		}
	})), nr = Fn(k({}, Un, {
		pointerId: 0,
		width: 0,
		height: 0,
		pressure: 0,
		tangentialPressure: 0,
		tiltX: 0,
		tiltY: 0,
		twist: 0,
		pointerType: 0,
		isPrimary: 0
	})), rr = Fn(k({}, Rn, {
		touches: 0,
		targetTouches: 0,
		changedTouches: 0,
		altKey: 0,
		metaKey: 0,
		ctrlKey: 0,
		shiftKey: 0,
		getModifierState: er
	})), ir = Fn(k({}, In, {
		propertyName: 0,
		elapsedTime: 0,
		pseudoElement: 0
	})), ar = Fn(k({}, Un, {
		deltaX: function(e) {
			return "deltaX" in e ? e.deltaX : "wheelDeltaX" in e ? -e.wheelDeltaX : 0;
		},
		deltaY: function(e) {
			return "deltaY" in e ? e.deltaY : "wheelDeltaY" in e ? -e.wheelDeltaY : "wheelDelta" in e ? -e.wheelDelta : 0;
		},
		deltaZ: 0,
		deltaMode: 0
	})), or = [
		9,
		13,
		27,
		32
	], sr = c && "CompositionEvent" in window, cr = null;
	c && "documentMode" in document && (cr = document.documentMode);
	var lr = c && "TextEvent" in window && !cr, ur = c && (!sr || cr && 8 < cr && 11 >= cr), dr = " ", fr = !1;
	function pr(e, t) {
		switch (e) {
			case "keyup": return or.indexOf(t.keyCode) !== -1;
			case "keydown": return t.keyCode !== 229;
			case "keypress":
			case "mousedown":
			case "focusout": return !0;
			default: return !1;
		}
	}
	function mr(e) {
		return e = e.detail, typeof e == "object" && "data" in e ? e.data : null;
	}
	var hr = !1;
	function gr(e, t) {
		switch (e) {
			case "compositionend": return mr(t);
			case "keypress": return t.which === 32 ? (fr = !0, dr) : null;
			case "textInput": return e = t.data, e === dr && fr ? null : e;
			default: return null;
		}
	}
	function _r(e, t) {
		if (hr) return e === "compositionend" || !sr && pr(e, t) ? (e = jn(), An = kn = On = null, hr = !1, e) : null;
		switch (e) {
			case "paste": return null;
			case "keypress":
				if (!(t.ctrlKey || t.altKey || t.metaKey) || t.ctrlKey && t.altKey) {
					if (t.char && 1 < t.char.length) return t.char;
					if (t.which) return String.fromCharCode(t.which);
				}
				return null;
			case "compositionend": return ur && t.locale !== "ko" ? null : t.data;
			default: return null;
		}
	}
	var vr = {
		color: !0,
		date: !0,
		datetime: !0,
		"datetime-local": !0,
		email: !0,
		month: !0,
		number: !0,
		password: !0,
		range: !0,
		search: !0,
		tel: !0,
		text: !0,
		time: !0,
		url: !0,
		week: !0
	};
	function yr(e) {
		var t = e && e.nodeName && e.nodeName.toLowerCase();
		return t === "input" ? !!vr[e.type] : t === "textarea";
	}
	function br(e, t, n, r) {
		Ze(r), t = xi(t, "onChange"), 0 < t.length && (n = new Ln("onChange", "change", null, n, r), e.push({
			event: n,
			listeners: t
		}));
	}
	var xr = null, Sr = null;
	function Cr(e) {
		mi(e, 0);
	}
	function wr(e) {
		if (j(Yi(e))) return e;
	}
	function Tr(e, t) {
		if (e === "change") return t;
	}
	var Er = !1;
	if (c) {
		var Dr;
		if (c) {
			var Or = "oninput" in document;
			if (!Or) {
				var kr = document.createElement("div");
				kr.setAttribute("oninput", "return;"), Or = typeof kr.oninput == "function";
			}
			Dr = Or;
		} else Dr = !1;
		Er = Dr && (!document.documentMode || 9 < document.documentMode);
	}
	function Ar() {
		xr && (xr.detachEvent("onpropertychange", jr), Sr = xr = null);
	}
	function jr(e) {
		if (e.propertyName === "value" && wr(Sr)) {
			var t = [];
			br(t, Sr, e, Ke(e)), nt(Cr, t);
		}
	}
	function Mr(e, t, n) {
		e === "focusin" ? (Ar(), xr = t, Sr = n, xr.attachEvent("onpropertychange", jr)) : e === "focusout" && Ar();
	}
	function Nr(e) {
		if (e === "selectionchange" || e === "keyup" || e === "keydown") return wr(Sr);
	}
	function Pr(e, t) {
		if (e === "click") return wr(t);
	}
	function Fr(e, t) {
		if (e === "input" || e === "change") return wr(t);
	}
	function Ir(e, t) {
		return e === t && (e !== 0 || 1 / e == 1 / t) || e !== e && t !== t;
	}
	var Lr = typeof Object.is == "function" ? Object.is : Ir;
	function Rr(e, t) {
		if (Lr(e, t)) return !0;
		if (typeof e != "object" || !e || typeof t != "object" || !t) return !1;
		var n = Object.keys(e), r = Object.keys(t);
		if (n.length !== r.length) return !1;
		for (r = 0; r < n.length; r++) {
			var i = n[r];
			if (!l.call(t, i) || !Lr(e[i], t[i])) return !1;
		}
		return !0;
	}
	function zr(e) {
		for (; e && e.firstChild;) e = e.firstChild;
		return e;
	}
	function Br(e, t) {
		var n = zr(e);
		e = 0;
		for (var r; n;) {
			if (n.nodeType === 3) {
				if (r = e + n.textContent.length, e <= t && r >= t) return {
					node: n,
					offset: t - e
				};
				e = r;
			}
			a: {
				for (; n;) {
					if (n.nextSibling) {
						n = n.nextSibling;
						break a;
					}
					n = n.parentNode;
				}
				n = void 0;
			}
			n = zr(n);
		}
	}
	function Vr(e, t) {
		return e && t ? e === t ? !0 : e && e.nodeType === 3 ? !1 : t && t.nodeType === 3 ? Vr(e, t.parentNode) : "contains" in e ? e.contains(t) : e.compareDocumentPosition ? !!(e.compareDocumentPosition(t) & 16) : !1 : !1;
	}
	function Hr() {
		for (var e = window, t = be(); t instanceof e.HTMLIFrameElement;) {
			try {
				var n = typeof t.contentWindow.location.href == "string";
			} catch {
				n = !1;
			}
			if (n) e = t.contentWindow;
			else break;
			t = be(e.document);
		}
		return t;
	}
	function Ur(e) {
		var t = e && e.nodeName && e.nodeName.toLowerCase();
		return t && (t === "input" && (e.type === "text" || e.type === "search" || e.type === "tel" || e.type === "url" || e.type === "password") || t === "textarea" || e.contentEditable === "true");
	}
	function Wr(e) {
		var t = Hr(), n = e.focusedElem, r = e.selectionRange;
		if (t !== n && n && n.ownerDocument && Vr(n.ownerDocument.documentElement, n)) {
			if (r !== null && Ur(n)) {
				if (t = r.start, e = r.end, e === void 0 && (e = t), "selectionStart" in n) n.selectionStart = t, n.selectionEnd = Math.min(e, n.value.length);
				else if (e = (t = n.ownerDocument || document) && t.defaultView || window, e.getSelection) {
					e = e.getSelection();
					var i = n.textContent.length, a = Math.min(r.start, i);
					r = r.end === void 0 ? a : Math.min(r.end, i), !e.extend && a > r && (i = r, r = a, a = i), i = Br(n, a);
					var o = Br(n, r);
					i && o && (e.rangeCount !== 1 || e.anchorNode !== i.node || e.anchorOffset !== i.offset || e.focusNode !== o.node || e.focusOffset !== o.offset) && (t = t.createRange(), t.setStart(i.node, i.offset), e.removeAllRanges(), a > r ? (e.addRange(t), e.extend(o.node, o.offset)) : (t.setEnd(o.node, o.offset), e.addRange(t)));
				}
			}
			for (t = [], e = n; e = e.parentNode;) e.nodeType === 1 && t.push({
				element: e,
				left: e.scrollLeft,
				top: e.scrollTop
			});
			for (typeof n.focus == "function" && n.focus(), n = 0; n < t.length; n++) e = t[n], e.element.scrollLeft = e.left, e.element.scrollTop = e.top;
		}
	}
	var Gr = c && "documentMode" in document && 11 >= document.documentMode, Kr = null, qr = null, Jr = null, Yr = !1;
	function Xr(e, t, n) {
		var r = n.window === n ? n.document : n.nodeType === 9 ? n : n.ownerDocument;
		Yr || Kr == null || Kr !== be(r) || (r = Kr, "selectionStart" in r && Ur(r) ? r = {
			start: r.selectionStart,
			end: r.selectionEnd
		} : (r = (r.ownerDocument && r.ownerDocument.defaultView || window).getSelection(), r = {
			anchorNode: r.anchorNode,
			anchorOffset: r.anchorOffset,
			focusNode: r.focusNode,
			focusOffset: r.focusOffset
		}), Jr && Rr(Jr, r) || (Jr = r, r = xi(qr, "onSelect"), 0 < r.length && (t = new Ln("onSelect", "select", null, t, n), e.push({
			event: t,
			listeners: r
		}), t.target = Kr)));
	}
	function Zr(e, t) {
		var n = {};
		return n[e.toLowerCase()] = t.toLowerCase(), n["Webkit" + e] = "webkit" + t, n["Moz" + e] = "moz" + t, n;
	}
	var Qr = {
		animationend: Zr("Animation", "AnimationEnd"),
		animationiteration: Zr("Animation", "AnimationIteration"),
		animationstart: Zr("Animation", "AnimationStart"),
		transitionend: Zr("Transition", "TransitionEnd")
	}, $r = {}, ei = {};
	c && (ei = document.createElement("div").style, "AnimationEvent" in window || (delete Qr.animationend.animation, delete Qr.animationiteration.animation, delete Qr.animationstart.animation), "TransitionEvent" in window || delete Qr.transitionend.transition);
	function ti(e) {
		if ($r[e]) return $r[e];
		if (!Qr[e]) return e;
		var t = Qr[e], n;
		for (n in t) if (t.hasOwnProperty(n) && n in ei) return $r[e] = t[n];
		return e;
	}
	var ni = ti("animationend"), ri = ti("animationiteration"), ii = ti("animationstart"), ai = ti("transitionend"), oi = /* @__PURE__ */ new Map(), si = "abort auxClick cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(" ");
	function ci(e, t) {
		oi.set(e, t), o(t, [e]);
	}
	for (var li = 0; li < si.length; li++) {
		var ui = si[li];
		ci(ui.toLowerCase(), "on" + (ui[0].toUpperCase() + ui.slice(1)));
	}
	ci(ni, "onAnimationEnd"), ci(ri, "onAnimationIteration"), ci(ii, "onAnimationStart"), ci("dblclick", "onDoubleClick"), ci("focusin", "onFocus"), ci("focusout", "onBlur"), ci(ai, "onTransitionEnd"), s("onMouseEnter", ["mouseout", "mouseover"]), s("onMouseLeave", ["mouseout", "mouseover"]), s("onPointerEnter", ["pointerout", "pointerover"]), s("onPointerLeave", ["pointerout", "pointerover"]), o("onChange", "change click focusin focusout input keydown keyup selectionchange".split(" ")), o("onSelect", "focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(" ")), o("onBeforeInput", [
		"compositionend",
		"keypress",
		"textInput",
		"paste"
	]), o("onCompositionEnd", "compositionend focusout keydown keypress keyup mousedown".split(" ")), o("onCompositionStart", "compositionstart focusout keydown keypress keyup mousedown".split(" ")), o("onCompositionUpdate", "compositionupdate focusout keydown keypress keyup mousedown".split(" "));
	var di = "abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(" "), fi = new Set("cancel close invalid load scroll toggle".split(" ").concat(di));
	function pi(e, t, n) {
		var r = e.type || "unknown-event";
		e.currentTarget = n, pt(r, t, void 0, e), e.currentTarget = null;
	}
	function mi(e, t) {
		t = (t & 4) != 0;
		for (var n = 0; n < e.length; n++) {
			var r = e[n], i = r.event;
			r = r.listeners;
			a: {
				var a = void 0;
				if (t) for (var o = r.length - 1; 0 <= o; o--) {
					var s = r[o], c = s.instance, l = s.currentTarget;
					if (s = s.listener, c !== a && i.isPropagationStopped()) break a;
					pi(i, s, l), a = c;
				}
				else for (o = 0; o < r.length; o++) {
					if (s = r[o], c = s.instance, l = s.currentTarget, s = s.listener, c !== a && i.isPropagationStopped()) break a;
					pi(i, s, l), a = c;
				}
			}
		}
		if (lt) throw e = ut, lt = !1, ut = null, e;
	}
	function P(e, t) {
		var n = t[Wi];
		n === void 0 && (n = t[Wi] = /* @__PURE__ */ new Set());
		var r = e + "__bubble";
		n.has(r) || (vi(t, e, 2, !1), n.add(r));
	}
	function hi(e, t, n) {
		var r = 0;
		t && (r |= 4), vi(n, e, r, t);
	}
	var gi = "_reactListening" + Math.random().toString(36).slice(2);
	function _i(e) {
		if (!e[gi]) {
			e[gi] = !0, i.forEach(function(t) {
				t !== "selectionchange" && (fi.has(t) || hi(t, !1, e), hi(t, !0, e));
			});
			var t = e.nodeType === 9 ? e : e.ownerDocument;
			t === null || t[gi] || (t[gi] = !0, hi("selectionchange", !1, t));
		}
	}
	function vi(e, t, n, r) {
		switch (Dn(t)) {
			case 1:
				var i = Sn;
				break;
			case 4:
				i = Cn;
				break;
			default: i = wn;
		}
		n = i.bind(null, t, n, e), i = void 0, !it || t !== "touchstart" && t !== "touchmove" && t !== "wheel" || (i = !0), r ? i === void 0 ? e.addEventListener(t, n, !0) : e.addEventListener(t, n, {
			capture: !0,
			passive: i
		}) : i === void 0 ? e.addEventListener(t, n, !1) : e.addEventListener(t, n, { passive: i });
	}
	function yi(e, t, n, r, i) {
		var a = r;
		if (!(t & 1) && !(t & 2) && r !== null) a: for (;;) {
			if (r === null) return;
			var o = r.tag;
			if (o === 3 || o === 4) {
				var s = r.stateNode.containerInfo;
				if (s === i || s.nodeType === 8 && s.parentNode === i) break;
				if (o === 4) for (o = r.return; o !== null;) {
					var c = o.tag;
					if ((c === 3 || c === 4) && (c = o.stateNode.containerInfo, c === i || c.nodeType === 8 && c.parentNode === i)) return;
					o = o.return;
				}
				for (; s !== null;) {
					if (o = qi(s), o === null) return;
					if (c = o.tag, c === 5 || c === 6) {
						r = a = o;
						continue a;
					}
					s = s.parentNode;
				}
			}
			r = r.return;
		}
		nt(function() {
			var r = a, i = Ke(n), o = [];
			a: {
				var s = oi.get(e);
				if (s !== void 0) {
					var c = Ln, l = e;
					switch (e) {
						case "keypress": if (Mn(n) === 0) break a;
						case "keydown":
						case "keyup":
							c = tr;
							break;
						case "focusin":
							l = "focus", c = Kn;
							break;
						case "focusout":
							l = "blur", c = Kn;
							break;
						case "beforeblur":
						case "afterblur":
							c = Kn;
							break;
						case "click": if (n.button === 2) break a;
						case "auxclick":
						case "dblclick":
						case "mousedown":
						case "mousemove":
						case "mouseup":
						case "mouseout":
						case "mouseover":
						case "contextmenu":
							c = Wn;
							break;
						case "drag":
						case "dragend":
						case "dragenter":
						case "dragexit":
						case "dragleave":
						case "dragover":
						case "dragstart":
						case "drop":
							c = Gn;
							break;
						case "touchcancel":
						case "touchend":
						case "touchmove":
						case "touchstart":
							c = rr;
							break;
						case ni:
						case ri:
						case ii:
							c = qn;
							break;
						case ai:
							c = ir;
							break;
						case "scroll":
							c = zn;
							break;
						case "wheel":
							c = ar;
							break;
						case "copy":
						case "cut":
						case "paste":
							c = Jn;
							break;
						case "gotpointercapture":
						case "lostpointercapture":
						case "pointercancel":
						case "pointerdown":
						case "pointermove":
						case "pointerout":
						case "pointerover":
						case "pointerup": c = nr;
					}
					var u = (t & 4) != 0, d = !u && e === "scroll", f = u ? s === null ? null : s + "Capture" : s;
					u = [];
					for (var p = r, m; p !== null;) {
						m = p;
						var h = m.stateNode;
						if (m.tag === 5 && h !== null && (m = h, f !== null && (h = rt(p, f), h != null && u.push(bi(p, h, m)))), d) break;
						p = p.return;
					}
					0 < u.length && (s = new c(s, l, null, n, i), o.push({
						event: s,
						listeners: u
					}));
				}
			}
			if (!(t & 7)) {
				a: {
					if (s = e === "mouseover" || e === "pointerover", c = e === "mouseout" || e === "pointerout", s && n !== Ge && (l = n.relatedTarget || n.fromElement) && (qi(l) || l[Ui])) break a;
					if ((c || s) && (s = i.window === i ? i : (s = i.ownerDocument) ? s.defaultView || s.parentWindow : window, c ? (l = n.relatedTarget || n.toElement, c = r, l = l ? qi(l) : null, l !== null && (d = mt(l), l !== d || l.tag !== 5 && l.tag !== 6) && (l = null)) : (c = null, l = r), c !== l)) {
						if (u = Wn, h = "onMouseLeave", f = "onMouseEnter", p = "mouse", (e === "pointerout" || e === "pointerover") && (u = nr, h = "onPointerLeave", f = "onPointerEnter", p = "pointer"), d = c == null ? s : Yi(c), m = l == null ? s : Yi(l), s = new u(h, p + "leave", c, n, i), s.target = d, s.relatedTarget = m, h = null, qi(i) === r && (u = new u(f, p + "enter", l, n, i), u.target = m, u.relatedTarget = d, h = u), d = h, c && l) b: {
							for (u = c, f = l, p = 0, m = u; m; m = Si(m)) p++;
							for (m = 0, h = f; h; h = Si(h)) m++;
							for (; 0 < p - m;) u = Si(u), p--;
							for (; 0 < m - p;) f = Si(f), m--;
							for (; p--;) {
								if (u === f || f !== null && u === f.alternate) break b;
								u = Si(u), f = Si(f);
							}
							u = null;
						}
						else u = null;
						c !== null && Ci(o, s, c, u, !1), l !== null && d !== null && Ci(o, d, l, u, !0);
					}
				}
				a: {
					if (s = r ? Yi(r) : window, c = s.nodeName && s.nodeName.toLowerCase(), c === "select" || c === "input" && s.type === "file") var g = Tr;
					else if (yr(s)) if (Er) g = Fr;
					else {
						g = Nr;
						var _ = Mr;
					}
					else (c = s.nodeName) && c.toLowerCase() === "input" && (s.type === "checkbox" || s.type === "radio") && (g = Pr);
					if (g &&= g(e, r)) {
						br(o, g, n, i);
						break a;
					}
					_ && _(e, s, r), e === "focusout" && (_ = s._wrapperState) && _.controlled && s.type === "number" && Ee(s, "number", s.value);
				}
				switch (_ = r ? Yi(r) : window, e) {
					case "focusin":
						(yr(_) || _.contentEditable === "true") && (Kr = _, qr = r, Jr = null);
						break;
					case "focusout":
						Jr = qr = Kr = null;
						break;
					case "mousedown":
						Yr = !0;
						break;
					case "contextmenu":
					case "mouseup":
					case "dragend":
						Yr = !1, Xr(o, n, i);
						break;
					case "selectionchange": if (Gr) break;
					case "keydown":
					case "keyup": Xr(o, n, i);
				}
				var v;
				if (sr) b: {
					switch (e) {
						case "compositionstart":
							var y = "onCompositionStart";
							break b;
						case "compositionend":
							y = "onCompositionEnd";
							break b;
						case "compositionupdate":
							y = "onCompositionUpdate";
							break b;
					}
					y = void 0;
				}
				else hr ? pr(e, n) && (y = "onCompositionEnd") : e === "keydown" && n.keyCode === 229 && (y = "onCompositionStart");
				y && (ur && n.locale !== "ko" && (hr || y !== "onCompositionStart" ? y === "onCompositionEnd" && hr && (v = jn()) : (On = i, kn = "value" in On ? On.value : On.textContent, hr = !0)), _ = xi(r, y), 0 < _.length && (y = new Yn(y, e, null, n, i), o.push({
					event: y,
					listeners: _
				}), v ? y.data = v : (v = mr(n), v !== null && (y.data = v)))), (v = lr ? gr(e, n) : _r(e, n)) && (r = xi(r, "onBeforeInput"), 0 < r.length && (i = new Yn("onBeforeInput", "beforeinput", null, n, i), o.push({
					event: i,
					listeners: r
				}), i.data = v));
			}
			mi(o, t);
		});
	}
	function bi(e, t, n) {
		return {
			instance: e,
			listener: t,
			currentTarget: n
		};
	}
	function xi(e, t) {
		for (var n = t + "Capture", r = []; e !== null;) {
			var i = e, a = i.stateNode;
			i.tag === 5 && a !== null && (i = a, a = rt(e, n), a != null && r.unshift(bi(e, a, i)), a = rt(e, t), a != null && r.push(bi(e, a, i))), e = e.return;
		}
		return r;
	}
	function Si(e) {
		if (e === null) return null;
		do
			e = e.return;
		while (e && e.tag !== 5);
		return e || null;
	}
	function Ci(e, t, n, r, i) {
		for (var a = t._reactName, o = []; n !== null && n !== r;) {
			var s = n, c = s.alternate, l = s.stateNode;
			if (c !== null && c === r) break;
			s.tag === 5 && l !== null && (s = l, i ? (c = rt(n, a), c != null && o.unshift(bi(n, c, s))) : i || (c = rt(n, a), c != null && o.push(bi(n, c, s)))), n = n.return;
		}
		o.length !== 0 && e.push({
			event: t,
			listeners: o
		});
	}
	var wi = /\r\n?/g, Ti = /\u0000|\uFFFD/g;
	function Ei(e) {
		return (typeof e == "string" ? e : "" + e).replace(wi, "\n").replace(Ti, "");
	}
	function Di(e, t, n) {
		if (t = Ei(t), Ei(e) !== t && n) throw Error(r(425));
	}
	function Oi() {}
	var ki = null, Ai = null;
	function ji(e, t) {
		return e === "textarea" || e === "noscript" || typeof t.children == "string" || typeof t.children == "number" || typeof t.dangerouslySetInnerHTML == "object" && t.dangerouslySetInnerHTML !== null && t.dangerouslySetInnerHTML.__html != null;
	}
	var Mi = typeof setTimeout == "function" ? setTimeout : void 0, Ni = typeof clearTimeout == "function" ? clearTimeout : void 0, Pi = typeof Promise == "function" ? Promise : void 0, Fi = typeof queueMicrotask == "function" ? queueMicrotask : Pi === void 0 ? Mi : function(e) {
		return Pi.resolve(null).then(e).catch(Ii);
	};
	function Ii(e) {
		setTimeout(function() {
			throw e;
		});
	}
	function Li(e, t) {
		var n = t, r = 0;
		do {
			var i = n.nextSibling;
			if (e.removeChild(n), i && i.nodeType === 8) if (n = i.data, n === "/$") {
				if (r === 0) {
					e.removeChild(i), yn(t);
					return;
				}
				r--;
			} else n !== "$" && n !== "$?" && n !== "$!" || r++;
			n = i;
		} while (n);
		yn(t);
	}
	function Ri(e) {
		for (; e != null; e = e.nextSibling) {
			var t = e.nodeType;
			if (t === 1 || t === 3) break;
			if (t === 8) {
				if (t = e.data, t === "$" || t === "$!" || t === "$?") break;
				if (t === "/$") return null;
			}
		}
		return e;
	}
	function zi(e) {
		e = e.previousSibling;
		for (var t = 0; e;) {
			if (e.nodeType === 8) {
				var n = e.data;
				if (n === "$" || n === "$!" || n === "$?") {
					if (t === 0) return e;
					t--;
				} else n === "/$" && t++;
			}
			e = e.previousSibling;
		}
		return null;
	}
	var Bi = Math.random().toString(36).slice(2), Vi = "__reactFiber$" + Bi, Hi = "__reactProps$" + Bi, Ui = "__reactContainer$" + Bi, Wi = "__reactEvents$" + Bi, Gi = "__reactListeners$" + Bi, Ki = "__reactHandles$" + Bi;
	function qi(e) {
		var t = e[Vi];
		if (t) return t;
		for (var n = e.parentNode; n;) {
			if (t = n[Ui] || n[Vi]) {
				if (n = t.alternate, t.child !== null || n !== null && n.child !== null) for (e = zi(e); e !== null;) {
					if (n = e[Vi]) return n;
					e = zi(e);
				}
				return t;
			}
			e = n, n = e.parentNode;
		}
		return null;
	}
	function Ji(e) {
		return e = e[Vi] || e[Ui], !e || e.tag !== 5 && e.tag !== 6 && e.tag !== 13 && e.tag !== 3 ? null : e;
	}
	function Yi(e) {
		if (e.tag === 5 || e.tag === 6) return e.stateNode;
		throw Error(r(33));
	}
	function Xi(e) {
		return e[Hi] || null;
	}
	var Zi = [], Qi = -1;
	function $i(e) {
		return { current: e };
	}
	function F(e) {
		0 > Qi || (e.current = Zi[Qi], Zi[Qi] = null, Qi--);
	}
	function I(e, t) {
		Qi++, Zi[Qi] = e.current, e.current = t;
	}
	var ea = {}, L = $i(ea), ta = $i(!1), na = ea;
	function ra(e, t) {
		var n = e.type.contextTypes;
		if (!n) return ea;
		var r = e.stateNode;
		if (r && r.__reactInternalMemoizedUnmaskedChildContext === t) return r.__reactInternalMemoizedMaskedChildContext;
		var i = {}, a;
		for (a in n) i[a] = t[a];
		return r && (e = e.stateNode, e.__reactInternalMemoizedUnmaskedChildContext = t, e.__reactInternalMemoizedMaskedChildContext = i), i;
	}
	function ia(e) {
		return e = e.childContextTypes, e != null;
	}
	function aa() {
		F(ta), F(L);
	}
	function oa(e, t, n) {
		if (L.current !== ea) throw Error(r(168));
		I(L, t), I(ta, n);
	}
	function sa(e, t, n) {
		var i = e.stateNode;
		if (t = t.childContextTypes, typeof i.getChildContext != "function") return n;
		for (var a in i = i.getChildContext(), i) if (!(a in t)) throw Error(r(108, ge(e) || "Unknown", a));
		return k({}, n, i);
	}
	function ca(e) {
		return e = (e = e.stateNode) && e.__reactInternalMemoizedMergedChildContext || ea, na = L.current, I(L, e), I(ta, ta.current), !0;
	}
	function la(e, t, n) {
		var i = e.stateNode;
		if (!i) throw Error(r(169));
		n ? (e = sa(e, t, na), i.__reactInternalMemoizedMergedChildContext = e, F(ta), F(L), I(L, e)) : F(ta), I(ta, n);
	}
	var ua = null, da = !1, fa = !1;
	function pa(e) {
		ua === null ? ua = [e] : ua.push(e);
	}
	function ma(e) {
		da = !0, pa(e);
	}
	function ha() {
		if (!fa && ua !== null) {
			fa = !0;
			var e = 0, t = N;
			try {
				var n = ua;
				for (N = 1; e < n.length; e++) {
					var r = n[e];
					do
						r = r(!0);
					while (r !== null);
				}
				ua = null, da = !1;
			} catch (t) {
				throw ua !== null && (ua = ua.slice(e + 1)), bt(Tt, ha), t;
			} finally {
				N = t, fa = !1;
			}
		}
		return null;
	}
	var ga = [], _a = 0, va = null, ya = 0, ba = [], xa = 0, Sa = null, Ca = 1, wa = "";
	function Ta(e, t) {
		ga[_a++] = ya, ga[_a++] = va, va = e, ya = t;
	}
	function Ea(e, t, n) {
		ba[xa++] = Ca, ba[xa++] = wa, ba[xa++] = Sa, Sa = e;
		var r = Ca;
		e = wa;
		var i = 32 - Nt(r) - 1;
		r &= ~(1 << i), n += 1;
		var a = 32 - Nt(t) + i;
		if (30 < a) {
			var o = i - i % 5;
			a = (r & (1 << o) - 1).toString(32), r >>= o, i -= o, Ca = 1 << 32 - Nt(t) + i | n << i | r, wa = a + e;
		} else Ca = 1 << a | n << i | r, wa = e;
	}
	function Da(e) {
		e.return !== null && (Ta(e, 1), Ea(e, 1, 0));
	}
	function Oa(e) {
		for (; e === va;) va = ga[--_a], ga[_a] = null, ya = ga[--_a], ga[_a] = null;
		for (; e === Sa;) Sa = ba[--xa], ba[xa] = null, wa = ba[--xa], ba[xa] = null, Ca = ba[--xa], ba[xa] = null;
	}
	var ka = null, Aa = null, R = !1, ja = null;
	function Ma(e, t) {
		var n = Kl(5, null, null, 0);
		n.elementType = "DELETED", n.stateNode = t, n.return = e, t = e.deletions, t === null ? (e.deletions = [n], e.flags |= 16) : t.push(n);
	}
	function Na(e, t) {
		switch (e.tag) {
			case 5:
				var n = e.type;
				return t = t.nodeType !== 1 || n.toLowerCase() !== t.nodeName.toLowerCase() ? null : t, t === null ? !1 : (e.stateNode = t, ka = e, Aa = Ri(t.firstChild), !0);
			case 6: return t = e.pendingProps === "" || t.nodeType !== 3 ? null : t, t === null ? !1 : (e.stateNode = t, ka = e, Aa = null, !0);
			case 13: return t = t.nodeType === 8 ? t : null, t === null ? !1 : (n = Sa === null ? null : {
				id: Ca,
				overflow: wa
			}, e.memoizedState = {
				dehydrated: t,
				treeContext: n,
				retryLane: 1073741824
			}, n = Kl(18, null, null, 0), n.stateNode = t, n.return = e, e.child = n, ka = e, Aa = null, !0);
			default: return !1;
		}
	}
	function Pa(e) {
		return (e.mode & 1) != 0 && (e.flags & 128) == 0;
	}
	function Fa(e) {
		if (R) {
			var t = Aa;
			if (t) {
				var n = t;
				if (!Na(e, t)) {
					if (Pa(e)) throw Error(r(418));
					t = Ri(n.nextSibling);
					var i = ka;
					t && Na(e, t) ? Ma(i, n) : (e.flags = e.flags & -4097 | 2, R = !1, ka = e);
				}
			} else {
				if (Pa(e)) throw Error(r(418));
				e.flags = e.flags & -4097 | 2, R = !1, ka = e;
			}
		}
	}
	function Ia(e) {
		for (e = e.return; e !== null && e.tag !== 5 && e.tag !== 3 && e.tag !== 13;) e = e.return;
		ka = e;
	}
	function La(e) {
		if (e !== ka) return !1;
		if (!R) return Ia(e), R = !0, !1;
		var t;
		if ((t = e.tag !== 3) && !(t = e.tag !== 5) && (t = e.type, t = t !== "head" && t !== "body" && !ji(e.type, e.memoizedProps)), t &&= Aa) {
			if (Pa(e)) throw Ra(), Error(r(418));
			for (; t;) Ma(e, t), t = Ri(t.nextSibling);
		}
		if (Ia(e), e.tag === 13) {
			if (e = e.memoizedState, e = e === null ? null : e.dehydrated, !e) throw Error(r(317));
			a: {
				for (e = e.nextSibling, t = 0; e;) {
					if (e.nodeType === 8) {
						var n = e.data;
						if (n === "/$") {
							if (t === 0) {
								Aa = Ri(e.nextSibling);
								break a;
							}
							t--;
						} else n !== "$" && n !== "$!" && n !== "$?" || t++;
					}
					e = e.nextSibling;
				}
				Aa = null;
			}
		} else Aa = ka ? Ri(e.stateNode.nextSibling) : null;
		return !0;
	}
	function Ra() {
		for (var e = Aa; e;) e = Ri(e.nextSibling);
	}
	function za() {
		Aa = ka = null, R = !1;
	}
	function Ba(e) {
		ja === null ? ja = [e] : ja.push(e);
	}
	var Va = S.ReactCurrentBatchConfig;
	function Ha(e, t, n) {
		if (e = n.ref, e !== null && typeof e != "function" && typeof e != "object") {
			if (n._owner) {
				if (n = n._owner, n) {
					if (n.tag !== 1) throw Error(r(309));
					var i = n.stateNode;
				}
				if (!i) throw Error(r(147, e));
				var a = i, o = "" + e;
				return t !== null && t.ref !== null && typeof t.ref == "function" && t.ref._stringRef === o ? t.ref : (t = function(e) {
					var t = a.refs;
					e === null ? delete t[o] : t[o] = e;
				}, t._stringRef = o, t);
			}
			if (typeof e != "string") throw Error(r(284));
			if (!n._owner) throw Error(r(290, e));
		}
		return e;
	}
	function Ua(e, t) {
		throw e = Object.prototype.toString.call(t), Error(r(31, e === "[object Object]" ? "object with keys {" + Object.keys(t).join(", ") + "}" : e));
	}
	function Wa(e) {
		var t = e._init;
		return t(e._payload);
	}
	function Ga(e) {
		function t(t, n) {
			if (e) {
				var r = t.deletions;
				r === null ? (t.deletions = [n], t.flags |= 16) : r.push(n);
			}
		}
		function n(n, r) {
			if (!e) return null;
			for (; r !== null;) t(n, r), r = r.sibling;
			return null;
		}
		function i(e, t) {
			for (e = /* @__PURE__ */ new Map(); t !== null;) t.key === null ? e.set(t.index, t) : e.set(t.key, t), t = t.sibling;
			return e;
		}
		function a(e, t) {
			return e = Yl(e, t), e.index = 0, e.sibling = null, e;
		}
		function o(t, n, r) {
			return t.index = r, e ? (r = t.alternate, r === null ? (t.flags |= 2, n) : (r = r.index, r < n ? (t.flags |= 2, n) : r)) : (t.flags |= 1048576, n);
		}
		function s(t) {
			return e && t.alternate === null && (t.flags |= 2), t;
		}
		function c(e, t, n, r) {
			return t === null || t.tag !== 6 ? (t = $l(n, e.mode, r), t.return = e, t) : (t = a(t, n), t.return = e, t);
		}
		function l(e, t, n, r) {
			var i = n.type;
			return i === ne ? d(e, t, n.props.children, r, n.key) : t !== null && (t.elementType === i || typeof i == "object" && i && i.$$typeof === D && Wa(i) === t.type) ? (r = a(t, n.props), r.ref = Ha(e, t, n), r.return = e, r) : (r = Xl(n.type, n.key, n.props, null, e.mode, r), r.ref = Ha(e, t, n), r.return = e, r);
		}
		function u(e, t, n, r) {
			return t === null || t.tag !== 4 || t.stateNode.containerInfo !== n.containerInfo || t.stateNode.implementation !== n.implementation ? (t = eu(n, e.mode, r), t.return = e, t) : (t = a(t, n.children || []), t.return = e, t);
		}
		function d(e, t, n, r, i) {
			return t === null || t.tag !== 7 ? (t = Zl(n, e.mode, r, i), t.return = e, t) : (t = a(t, n), t.return = e, t);
		}
		function f(e, t, n) {
			if (typeof t == "string" && t !== "" || typeof t == "number") return t = $l("" + t, e.mode, n), t.return = e, t;
			if (typeof t == "object" && t) {
				switch (t.$$typeof) {
					case te: return n = Xl(t.type, t.key, t.props, null, e.mode, n), n.ref = Ha(e, null, t), n.return = e, n;
					case C: return t = eu(t, e.mode, n), t.return = e, t;
					case D:
						var r = t._init;
						return f(e, r(t._payload), n);
				}
				if (De(t) || le(t)) return t = Zl(t, e.mode, n, null), t.return = e, t;
				Ua(e, t);
			}
			return null;
		}
		function p(e, t, n, r) {
			var i = t === null ? null : t.key;
			if (typeof n == "string" && n !== "" || typeof n == "number") return i === null ? c(e, t, "" + n, r) : null;
			if (typeof n == "object" && n) {
				switch (n.$$typeof) {
					case te: return n.key === i ? l(e, t, n, r) : null;
					case C: return n.key === i ? u(e, t, n, r) : null;
					case D: return i = n._init, p(e, t, i(n._payload), r);
				}
				if (De(n) || le(n)) return i === null ? d(e, t, n, r, null) : null;
				Ua(e, n);
			}
			return null;
		}
		function m(e, t, n, r, i) {
			if (typeof r == "string" && r !== "" || typeof r == "number") return e = e.get(n) || null, c(t, e, "" + r, i);
			if (typeof r == "object" && r) {
				switch (r.$$typeof) {
					case te: return e = e.get(r.key === null ? n : r.key) || null, l(t, e, r, i);
					case C: return e = e.get(r.key === null ? n : r.key) || null, u(t, e, r, i);
					case D:
						var a = r._init;
						return m(e, t, n, a(r._payload), i);
				}
				if (De(r) || le(r)) return e = e.get(n) || null, d(t, e, r, i, null);
				Ua(t, r);
			}
			return null;
		}
		function h(r, a, s, c) {
			for (var l = null, u = null, d = a, h = a = 0, g = null; d !== null && h < s.length; h++) {
				d.index > h ? (g = d, d = null) : g = d.sibling;
				var _ = p(r, d, s[h], c);
				if (_ === null) {
					d === null && (d = g);
					break;
				}
				e && d && _.alternate === null && t(r, d), a = o(_, a, h), u === null ? l = _ : u.sibling = _, u = _, d = g;
			}
			if (h === s.length) return n(r, d), R && Ta(r, h), l;
			if (d === null) {
				for (; h < s.length; h++) d = f(r, s[h], c), d !== null && (a = o(d, a, h), u === null ? l = d : u.sibling = d, u = d);
				return R && Ta(r, h), l;
			}
			for (d = i(r, d); h < s.length; h++) g = m(d, r, h, s[h], c), g !== null && (e && g.alternate !== null && d.delete(g.key === null ? h : g.key), a = o(g, a, h), u === null ? l = g : u.sibling = g, u = g);
			return e && d.forEach(function(e) {
				return t(r, e);
			}), R && Ta(r, h), l;
		}
		function g(a, s, c, l) {
			var u = le(c);
			if (typeof u != "function") throw Error(r(150));
			if (c = u.call(c), c == null) throw Error(r(151));
			for (var d = u = null, h = s, g = s = 0, _ = null, v = c.next(); h !== null && !v.done; g++, v = c.next()) {
				h.index > g ? (_ = h, h = null) : _ = h.sibling;
				var y = p(a, h, v.value, l);
				if (y === null) {
					h === null && (h = _);
					break;
				}
				e && h && y.alternate === null && t(a, h), s = o(y, s, g), d === null ? u = y : d.sibling = y, d = y, h = _;
			}
			if (v.done) return n(a, h), R && Ta(a, g), u;
			if (h === null) {
				for (; !v.done; g++, v = c.next()) v = f(a, v.value, l), v !== null && (s = o(v, s, g), d === null ? u = v : d.sibling = v, d = v);
				return R && Ta(a, g), u;
			}
			for (h = i(a, h); !v.done; g++, v = c.next()) v = m(h, a, g, v.value, l), v !== null && (e && v.alternate !== null && h.delete(v.key === null ? g : v.key), s = o(v, s, g), d === null ? u = v : d.sibling = v, d = v);
			return e && h.forEach(function(e) {
				return t(a, e);
			}), R && Ta(a, g), u;
		}
		function _(e, r, i, o) {
			if (typeof i == "object" && i && i.type === ne && i.key === null && (i = i.props.children), typeof i == "object" && i) {
				switch (i.$$typeof) {
					case te:
						a: {
							for (var c = i.key, l = r; l !== null;) {
								if (l.key === c) {
									if (c = i.type, c === ne) {
										if (l.tag === 7) {
											n(e, l.sibling), r = a(l, i.props.children), r.return = e, e = r;
											break a;
										}
									} else if (l.elementType === c || typeof c == "object" && c && c.$$typeof === D && Wa(c) === l.type) {
										n(e, l.sibling), r = a(l, i.props), r.ref = Ha(e, l, i), r.return = e, e = r;
										break a;
									}
									n(e, l);
									break;
								} else t(e, l);
								l = l.sibling;
							}
							i.type === ne ? (r = Zl(i.props.children, e.mode, o, i.key), r.return = e, e = r) : (o = Xl(i.type, i.key, i.props, null, e.mode, o), o.ref = Ha(e, r, i), o.return = e, e = o);
						}
						return s(e);
					case C:
						a: {
							for (l = i.key; r !== null;) {
								if (r.key === l) if (r.tag === 4 && r.stateNode.containerInfo === i.containerInfo && r.stateNode.implementation === i.implementation) {
									n(e, r.sibling), r = a(r, i.children || []), r.return = e, e = r;
									break a;
								} else {
									n(e, r);
									break;
								}
								else t(e, r);
								r = r.sibling;
							}
							r = eu(i, e.mode, o), r.return = e, e = r;
						}
						return s(e);
					case D: return l = i._init, _(e, r, l(i._payload), o);
				}
				if (De(i)) return h(e, r, i, o);
				if (le(i)) return g(e, r, i, o);
				Ua(e, i);
			}
			return typeof i == "string" && i !== "" || typeof i == "number" ? (i = "" + i, r !== null && r.tag === 6 ? (n(e, r.sibling), r = a(r, i), r.return = e, e = r) : (n(e, r), r = $l(i, e.mode, o), r.return = e, e = r), s(e)) : n(e, r);
		}
		return _;
	}
	var Ka = Ga(!0), qa = Ga(!1), Ja = $i(null), Ya = null, Xa = null, Za = null;
	function Qa() {
		Za = Xa = Ya = null;
	}
	function $a(e) {
		var t = Ja.current;
		F(Ja), e._currentValue = t;
	}
	function eo(e, t, n) {
		for (; e !== null;) {
			var r = e.alternate;
			if ((e.childLanes & t) === t ? r !== null && (r.childLanes & t) !== t && (r.childLanes |= t) : (e.childLanes |= t, r !== null && (r.childLanes |= t)), e === n) break;
			e = e.return;
		}
	}
	function to(e, t) {
		Ya = e, Za = Xa = null, e = e.dependencies, e !== null && e.firstContext !== null && ((e.lanes & t) !== 0 && (Bs = !0), e.firstContext = null);
	}
	function no(e) {
		var t = e._currentValue;
		if (Za !== e) if (e = {
			context: e,
			memoizedValue: t,
			next: null
		}, Xa === null) {
			if (Ya === null) throw Error(r(308));
			Xa = e, Ya.dependencies = {
				lanes: 0,
				firstContext: e
			};
		} else Xa = Xa.next = e;
		return t;
	}
	var ro = null;
	function io(e) {
		ro === null ? ro = [e] : ro.push(e);
	}
	function ao(e, t, n, r) {
		var i = t.interleaved;
		return i === null ? (n.next = n, io(t)) : (n.next = i.next, i.next = n), t.interleaved = n, oo(e, r);
	}
	function oo(e, t) {
		e.lanes |= t;
		var n = e.alternate;
		for (n !== null && (n.lanes |= t), n = e, e = e.return; e !== null;) e.childLanes |= t, n = e.alternate, n !== null && (n.childLanes |= t), n = e, e = e.return;
		return n.tag === 3 ? n.stateNode : null;
	}
	var so = !1;
	function co(e) {
		e.updateQueue = {
			baseState: e.memoizedState,
			firstBaseUpdate: null,
			lastBaseUpdate: null,
			shared: {
				pending: null,
				interleaved: null,
				lanes: 0
			},
			effects: null
		};
	}
	function lo(e, t) {
		e = e.updateQueue, t.updateQueue === e && (t.updateQueue = {
			baseState: e.baseState,
			firstBaseUpdate: e.firstBaseUpdate,
			lastBaseUpdate: e.lastBaseUpdate,
			shared: e.shared,
			effects: e.effects
		});
	}
	function uo(e, t) {
		return {
			eventTime: e,
			lane: t,
			tag: 0,
			payload: null,
			callback: null,
			next: null
		};
	}
	function fo(e, t, n) {
		var r = e.updateQueue;
		if (r === null) return null;
		if (r = r.shared, J & 2) {
			var i = r.pending;
			return i === null ? t.next = t : (t.next = i.next, i.next = t), r.pending = t, oo(e, n);
		}
		return i = r.interleaved, i === null ? (t.next = t, io(r)) : (t.next = i.next, i.next = t), r.interleaved = t, oo(e, n);
	}
	function po(e, t, n) {
		if (t = t.updateQueue, t !== null && (t = t.shared, n & 4194240)) {
			var r = t.lanes;
			r &= e.pendingLanes, n |= r, t.lanes = n, Jt(e, n);
		}
	}
	function mo(e, t) {
		var n = e.updateQueue, r = e.alternate;
		if (r !== null && (r = r.updateQueue, n === r)) {
			var i = null, a = null;
			if (n = n.firstBaseUpdate, n !== null) {
				do {
					var o = {
						eventTime: n.eventTime,
						lane: n.lane,
						tag: n.tag,
						payload: n.payload,
						callback: n.callback,
						next: null
					};
					a === null ? i = a = o : a = a.next = o, n = n.next;
				} while (n !== null);
				a === null ? i = a = t : a = a.next = t;
			} else i = a = t;
			n = {
				baseState: r.baseState,
				firstBaseUpdate: i,
				lastBaseUpdate: a,
				shared: r.shared,
				effects: r.effects
			}, e.updateQueue = n;
			return;
		}
		e = n.lastBaseUpdate, e === null ? n.firstBaseUpdate = t : e.next = t, n.lastBaseUpdate = t;
	}
	function ho(e, t, n, r) {
		var i = e.updateQueue;
		so = !1;
		var a = i.firstBaseUpdate, o = i.lastBaseUpdate, s = i.shared.pending;
		if (s !== null) {
			i.shared.pending = null;
			var c = s, l = c.next;
			c.next = null, o === null ? a = l : o.next = l, o = c;
			var u = e.alternate;
			u !== null && (u = u.updateQueue, s = u.lastBaseUpdate, s !== o && (s === null ? u.firstBaseUpdate = l : s.next = l, u.lastBaseUpdate = c));
		}
		if (a !== null) {
			var d = i.baseState;
			o = 0, u = l = c = null, s = a;
			do {
				var f = s.lane, p = s.eventTime;
				if ((r & f) === f) {
					u !== null && (u = u.next = {
						eventTime: p,
						lane: 0,
						tag: s.tag,
						payload: s.payload,
						callback: s.callback,
						next: null
					});
					a: {
						var m = e, h = s;
						switch (f = t, p = n, h.tag) {
							case 1:
								if (m = h.payload, typeof m == "function") {
									d = m.call(p, d, f);
									break a;
								}
								d = m;
								break a;
							case 3: m.flags = m.flags & -65537 | 128;
							case 0:
								if (m = h.payload, f = typeof m == "function" ? m.call(p, d, f) : m, f == null) break a;
								d = k({}, d, f);
								break a;
							case 2: so = !0;
						}
					}
					s.callback !== null && s.lane !== 0 && (e.flags |= 64, f = i.effects, f === null ? i.effects = [s] : f.push(s));
				} else p = {
					eventTime: p,
					lane: f,
					tag: s.tag,
					payload: s.payload,
					callback: s.callback,
					next: null
				}, u === null ? (l = u = p, c = d) : u = u.next = p, o |= f;
				if (s = s.next, s === null) {
					if (s = i.shared.pending, s === null) break;
					f = s, s = f.next, f.next = null, i.lastBaseUpdate = f, i.shared.pending = null;
				}
			} while (1);
			if (u === null && (c = d), i.baseState = c, i.firstBaseUpdate = l, i.lastBaseUpdate = u, t = i.shared.interleaved, t !== null) {
				i = t;
				do
					o |= i.lane, i = i.next;
				while (i !== t);
			} else a === null && (i.shared.lanes = 0);
			Yc |= o, e.lanes = o, e.memoizedState = d;
		}
	}
	function go(e, t, n) {
		if (e = t.effects, t.effects = null, e !== null) for (t = 0; t < e.length; t++) {
			var i = e[t], a = i.callback;
			if (a !== null) {
				if (i.callback = null, i = n, typeof a != "function") throw Error(r(191, a));
				a.call(i);
			}
		}
	}
	var _o = {}, vo = $i(_o), yo = $i(_o), bo = $i(_o);
	function xo(e) {
		if (e === _o) throw Error(r(174));
		return e;
	}
	function So(e, t) {
		switch (I(bo, t), I(yo, e), I(vo, _o), e = t.nodeType, e) {
			case 9:
			case 11:
				t = (t = t.documentElement) ? t.namespaceURI : Pe(null, "");
				break;
			default: e = e === 8 ? t.parentNode : t, t = e.namespaceURI || null, e = e.tagName, t = Pe(t, e);
		}
		F(vo), I(vo, t);
	}
	function Co() {
		F(vo), F(yo), F(bo);
	}
	function wo(e) {
		xo(bo.current);
		var t = xo(vo.current), n = Pe(t, e.type);
		t !== n && (I(yo, e), I(vo, n));
	}
	function To(e) {
		yo.current === e && (F(vo), F(yo));
	}
	var z = $i(0);
	function Eo(e) {
		for (var t = e; t !== null;) {
			if (t.tag === 13) {
				var n = t.memoizedState;
				if (n !== null && (n = n.dehydrated, n === null || n.data === "$?" || n.data === "$!")) return t;
			} else if (t.tag === 19 && t.memoizedProps.revealOrder !== void 0) {
				if (t.flags & 128) return t;
			} else if (t.child !== null) {
				t.child.return = t, t = t.child;
				continue;
			}
			if (t === e) break;
			for (; t.sibling === null;) {
				if (t.return === null || t.return === e) return null;
				t = t.return;
			}
			t.sibling.return = t.return, t = t.sibling;
		}
		return null;
	}
	var Do = [];
	function Oo() {
		for (var e = 0; e < Do.length; e++) Do[e]._workInProgressVersionPrimary = null;
		Do.length = 0;
	}
	var ko = S.ReactCurrentDispatcher, Ao = S.ReactCurrentBatchConfig, jo = 0, B = null, V = null, H = null, Mo = !1, No = !1, Po = 0, Fo = 0;
	function U() {
		throw Error(r(321));
	}
	function Io(e, t) {
		if (t === null) return !1;
		for (var n = 0; n < t.length && n < e.length; n++) if (!Lr(e[n], t[n])) return !1;
		return !0;
	}
	function Lo(e, t, n, i, a, o) {
		if (jo = o, B = t, t.memoizedState = null, t.updateQueue = null, t.lanes = 0, ko.current = e === null || e.memoizedState === null ? bs : xs, e = n(i, a), No) {
			o = 0;
			do {
				if (No = !1, Po = 0, 25 <= o) throw Error(r(301));
				o += 1, H = V = null, t.updateQueue = null, ko.current = Ss, e = n(i, a);
			} while (No);
		}
		if (ko.current = ys, t = V !== null && V.next !== null, jo = 0, H = V = B = null, Mo = !1, t) throw Error(r(300));
		return e;
	}
	function Ro() {
		var e = Po !== 0;
		return Po = 0, e;
	}
	function zo() {
		var e = {
			memoizedState: null,
			baseState: null,
			baseQueue: null,
			queue: null,
			next: null
		};
		return H === null ? B.memoizedState = H = e : H = H.next = e, H;
	}
	function Bo() {
		if (V === null) {
			var e = B.alternate;
			e = e === null ? null : e.memoizedState;
		} else e = V.next;
		var t = H === null ? B.memoizedState : H.next;
		if (t !== null) H = t, V = e;
		else {
			if (e === null) throw Error(r(310));
			V = e, e = {
				memoizedState: V.memoizedState,
				baseState: V.baseState,
				baseQueue: V.baseQueue,
				queue: V.queue,
				next: null
			}, H === null ? B.memoizedState = H = e : H = H.next = e;
		}
		return H;
	}
	function Vo(e, t) {
		return typeof t == "function" ? t(e) : t;
	}
	function Ho(e) {
		var t = Bo(), n = t.queue;
		if (n === null) throw Error(r(311));
		n.lastRenderedReducer = e;
		var i = V, a = i.baseQueue, o = n.pending;
		if (o !== null) {
			if (a !== null) {
				var s = a.next;
				a.next = o.next, o.next = s;
			}
			i.baseQueue = a = o, n.pending = null;
		}
		if (a !== null) {
			o = a.next, i = i.baseState;
			var c = s = null, l = null, u = o;
			do {
				var d = u.lane;
				if ((jo & d) === d) l !== null && (l = l.next = {
					lane: 0,
					action: u.action,
					hasEagerState: u.hasEagerState,
					eagerState: u.eagerState,
					next: null
				}), i = u.hasEagerState ? u.eagerState : e(i, u.action);
				else {
					var f = {
						lane: d,
						action: u.action,
						hasEagerState: u.hasEagerState,
						eagerState: u.eagerState,
						next: null
					};
					l === null ? (c = l = f, s = i) : l = l.next = f, B.lanes |= d, Yc |= d;
				}
				u = u.next;
			} while (u !== null && u !== o);
			l === null ? s = i : l.next = c, Lr(i, t.memoizedState) || (Bs = !0), t.memoizedState = i, t.baseState = s, t.baseQueue = l, n.lastRenderedState = i;
		}
		if (e = n.interleaved, e !== null) {
			a = e;
			do
				o = a.lane, B.lanes |= o, Yc |= o, a = a.next;
			while (a !== e);
		} else a === null && (n.lanes = 0);
		return [t.memoizedState, n.dispatch];
	}
	function Uo(e) {
		var t = Bo(), n = t.queue;
		if (n === null) throw Error(r(311));
		n.lastRenderedReducer = e;
		var i = n.dispatch, a = n.pending, o = t.memoizedState;
		if (a !== null) {
			n.pending = null;
			var s = a = a.next;
			do
				o = e(o, s.action), s = s.next;
			while (s !== a);
			Lr(o, t.memoizedState) || (Bs = !0), t.memoizedState = o, t.baseQueue === null && (t.baseState = o), n.lastRenderedState = o;
		}
		return [o, i];
	}
	function Wo() {}
	function Go(e, t) {
		var n = B, i = Bo(), a = t(), o = !Lr(i.memoizedState, a);
		if (o && (i.memoizedState = a, Bs = !0), i = i.queue, rs(Jo.bind(null, n, i, e), [e]), i.getSnapshot !== t || o || H !== null && H.memoizedState.tag & 1) {
			if (n.flags |= 2048, Qo(9, qo.bind(null, n, i, a, t), void 0, null), Y === null) throw Error(r(349));
			jo & 30 || Ko(n, t, a);
		}
		return a;
	}
	function Ko(e, t, n) {
		e.flags |= 16384, e = {
			getSnapshot: t,
			value: n
		}, t = B.updateQueue, t === null ? (t = {
			lastEffect: null,
			stores: null
		}, B.updateQueue = t, t.stores = [e]) : (n = t.stores, n === null ? t.stores = [e] : n.push(e));
	}
	function qo(e, t, n, r) {
		t.value = n, t.getSnapshot = r, Yo(t) && Xo(e);
	}
	function Jo(e, t, n) {
		return n(function() {
			Yo(t) && Xo(e);
		});
	}
	function Yo(e) {
		var t = e.getSnapshot;
		e = e.value;
		try {
			var n = t();
			return !Lr(e, n);
		} catch {
			return !0;
		}
	}
	function Xo(e) {
		var t = oo(e, 1);
		t !== null && hl(t, e, 1, -1);
	}
	function Zo(e) {
		var t = zo();
		return typeof e == "function" && (e = e()), t.memoizedState = t.baseState = e, e = {
			pending: null,
			interleaved: null,
			lanes: 0,
			dispatch: null,
			lastRenderedReducer: Vo,
			lastRenderedState: e
		}, t.queue = e, e = e.dispatch = hs.bind(null, B, e), [t.memoizedState, e];
	}
	function Qo(e, t, n, r) {
		return e = {
			tag: e,
			create: t,
			destroy: n,
			deps: r,
			next: null
		}, t = B.updateQueue, t === null ? (t = {
			lastEffect: null,
			stores: null
		}, B.updateQueue = t, t.lastEffect = e.next = e) : (n = t.lastEffect, n === null ? t.lastEffect = e.next = e : (r = n.next, n.next = e, e.next = r, t.lastEffect = e)), e;
	}
	function $o() {
		return Bo().memoizedState;
	}
	function es(e, t, n, r) {
		var i = zo();
		B.flags |= e, i.memoizedState = Qo(1 | t, n, void 0, r === void 0 ? null : r);
	}
	function ts(e, t, n, r) {
		var i = Bo();
		r = r === void 0 ? null : r;
		var a = void 0;
		if (V !== null) {
			var o = V.memoizedState;
			if (a = o.destroy, r !== null && Io(r, o.deps)) {
				i.memoizedState = Qo(t, n, a, r);
				return;
			}
		}
		B.flags |= e, i.memoizedState = Qo(1 | t, n, a, r);
	}
	function ns(e, t) {
		return es(8390656, 8, e, t);
	}
	function rs(e, t) {
		return ts(2048, 8, e, t);
	}
	function is(e, t) {
		return ts(4, 2, e, t);
	}
	function as(e, t) {
		return ts(4, 4, e, t);
	}
	function os(e, t) {
		if (typeof t == "function") return e = e(), t(e), function() {
			t(null);
		};
		if (t != null) return e = e(), t.current = e, function() {
			t.current = null;
		};
	}
	function ss(e, t, n) {
		return n = n == null ? null : n.concat([e]), ts(4, 4, os.bind(null, t, e), n);
	}
	function cs() {}
	function ls(e, t) {
		var n = Bo();
		t = t === void 0 ? null : t;
		var r = n.memoizedState;
		return r !== null && t !== null && Io(t, r[1]) ? r[0] : (n.memoizedState = [e, t], e);
	}
	function us(e, t) {
		var n = Bo();
		t = t === void 0 ? null : t;
		var r = n.memoizedState;
		return r !== null && t !== null && Io(t, r[1]) ? r[0] : (e = e(), n.memoizedState = [e, t], e);
	}
	function ds(e, t, n) {
		return jo & 21 ? (Lr(n, t) || (n = Wt(), B.lanes |= n, Yc |= n, e.baseState = !0), t) : (e.baseState && (e.baseState = !1, Bs = !0), e.memoizedState = n);
	}
	function fs(e, t) {
		var n = N;
		N = n !== 0 && 4 > n ? n : 4, e(!0);
		var r = Ao.transition;
		Ao.transition = {};
		try {
			e(!1), t();
		} finally {
			N = n, Ao.transition = r;
		}
	}
	function ps() {
		return Bo().memoizedState;
	}
	function ms(e, t, n) {
		var r = ml(e);
		if (n = {
			lane: r,
			action: n,
			hasEagerState: !1,
			eagerState: null,
			next: null
		}, gs(e)) _s(t, n);
		else if (n = ao(e, t, n, r), n !== null) {
			var i = pl();
			hl(n, e, r, i), vs(n, t, r);
		}
	}
	function hs(e, t, n) {
		var r = ml(e), i = {
			lane: r,
			action: n,
			hasEagerState: !1,
			eagerState: null,
			next: null
		};
		if (gs(e)) _s(t, i);
		else {
			var a = e.alternate;
			if (e.lanes === 0 && (a === null || a.lanes === 0) && (a = t.lastRenderedReducer, a !== null)) try {
				var o = t.lastRenderedState, s = a(o, n);
				if (i.hasEagerState = !0, i.eagerState = s, Lr(s, o)) {
					var c = t.interleaved;
					c === null ? (i.next = i, io(t)) : (i.next = c.next, c.next = i), t.interleaved = i;
					return;
				}
			} catch {}
			n = ao(e, t, i, r), n !== null && (i = pl(), hl(n, e, r, i), vs(n, t, r));
		}
	}
	function gs(e) {
		var t = e.alternate;
		return e === B || t !== null && t === B;
	}
	function _s(e, t) {
		No = Mo = !0;
		var n = e.pending;
		n === null ? t.next = t : (t.next = n.next, n.next = t), e.pending = t;
	}
	function vs(e, t, n) {
		if (n & 4194240) {
			var r = t.lanes;
			r &= e.pendingLanes, n |= r, t.lanes = n, Jt(e, n);
		}
	}
	var ys = {
		readContext: no,
		useCallback: U,
		useContext: U,
		useEffect: U,
		useImperativeHandle: U,
		useInsertionEffect: U,
		useLayoutEffect: U,
		useMemo: U,
		useReducer: U,
		useRef: U,
		useState: U,
		useDebugValue: U,
		useDeferredValue: U,
		useTransition: U,
		useMutableSource: U,
		useSyncExternalStore: U,
		useId: U,
		unstable_isNewReconciler: !1
	}, bs = {
		readContext: no,
		useCallback: function(e, t) {
			return zo().memoizedState = [e, t === void 0 ? null : t], e;
		},
		useContext: no,
		useEffect: ns,
		useImperativeHandle: function(e, t, n) {
			return n = n == null ? null : n.concat([e]), es(4194308, 4, os.bind(null, t, e), n);
		},
		useLayoutEffect: function(e, t) {
			return es(4194308, 4, e, t);
		},
		useInsertionEffect: function(e, t) {
			return es(4, 2, e, t);
		},
		useMemo: function(e, t) {
			var n = zo();
			return t = t === void 0 ? null : t, e = e(), n.memoizedState = [e, t], e;
		},
		useReducer: function(e, t, n) {
			var r = zo();
			return t = n === void 0 ? t : n(t), r.memoizedState = r.baseState = t, e = {
				pending: null,
				interleaved: null,
				lanes: 0,
				dispatch: null,
				lastRenderedReducer: e,
				lastRenderedState: t
			}, r.queue = e, e = e.dispatch = ms.bind(null, B, e), [r.memoizedState, e];
		},
		useRef: function(e) {
			var t = zo();
			return e = { current: e }, t.memoizedState = e;
		},
		useState: Zo,
		useDebugValue: cs,
		useDeferredValue: function(e) {
			return zo().memoizedState = e;
		},
		useTransition: function() {
			var e = Zo(!1), t = e[0];
			return e = fs.bind(null, e[1]), zo().memoizedState = e, [t, e];
		},
		useMutableSource: function() {},
		useSyncExternalStore: function(e, t, n) {
			var i = B, a = zo();
			if (R) {
				if (n === void 0) throw Error(r(407));
				n = n();
			} else {
				if (n = t(), Y === null) throw Error(r(349));
				jo & 30 || Ko(i, t, n);
			}
			a.memoizedState = n;
			var o = {
				value: n,
				getSnapshot: t
			};
			return a.queue = o, ns(Jo.bind(null, i, o, e), [e]), i.flags |= 2048, Qo(9, qo.bind(null, i, o, n, t), void 0, null), n;
		},
		useId: function() {
			var e = zo(), t = Y.identifierPrefix;
			if (R) {
				var n = wa, r = Ca;
				n = (r & ~(1 << 32 - Nt(r) - 1)).toString(32) + n, t = ":" + t + "R" + n, n = Po++, 0 < n && (t += "H" + n.toString(32)), t += ":";
			} else n = Fo++, t = ":" + t + "r" + n.toString(32) + ":";
			return e.memoizedState = t;
		},
		unstable_isNewReconciler: !1
	}, xs = {
		readContext: no,
		useCallback: ls,
		useContext: no,
		useEffect: rs,
		useImperativeHandle: ss,
		useInsertionEffect: is,
		useLayoutEffect: as,
		useMemo: us,
		useReducer: Ho,
		useRef: $o,
		useState: function() {
			return Ho(Vo);
		},
		useDebugValue: cs,
		useDeferredValue: function(e) {
			return ds(Bo(), V.memoizedState, e);
		},
		useTransition: function() {
			return [Ho(Vo)[0], Bo().memoizedState];
		},
		useMutableSource: Wo,
		useSyncExternalStore: Go,
		useId: ps,
		unstable_isNewReconciler: !1
	}, Ss = {
		readContext: no,
		useCallback: ls,
		useContext: no,
		useEffect: rs,
		useImperativeHandle: ss,
		useInsertionEffect: is,
		useLayoutEffect: as,
		useMemo: us,
		useReducer: Uo,
		useRef: $o,
		useState: function() {
			return Uo(Vo);
		},
		useDebugValue: cs,
		useDeferredValue: function(e) {
			var t = Bo();
			return V === null ? t.memoizedState = e : ds(t, V.memoizedState, e);
		},
		useTransition: function() {
			return [Uo(Vo)[0], Bo().memoizedState];
		},
		useMutableSource: Wo,
		useSyncExternalStore: Go,
		useId: ps,
		unstable_isNewReconciler: !1
	};
	function Cs(e, t) {
		if (e && e.defaultProps) {
			for (var n in t = k({}, t), e = e.defaultProps, e) t[n] === void 0 && (t[n] = e[n]);
			return t;
		}
		return t;
	}
	function ws(e, t, n, r) {
		t = e.memoizedState, n = n(r, t), n = n == null ? t : k({}, t, n), e.memoizedState = n, e.lanes === 0 && (e.updateQueue.baseState = n);
	}
	var Ts = {
		isMounted: function(e) {
			return (e = e._reactInternals) ? mt(e) === e : !1;
		},
		enqueueSetState: function(e, t, n) {
			e = e._reactInternals;
			var r = pl(), i = ml(e), a = uo(r, i);
			a.payload = t, n != null && (a.callback = n), t = fo(e, a, i), t !== null && (hl(t, e, i, r), po(t, e, i));
		},
		enqueueReplaceState: function(e, t, n) {
			e = e._reactInternals;
			var r = pl(), i = ml(e), a = uo(r, i);
			a.tag = 1, a.payload = t, n != null && (a.callback = n), t = fo(e, a, i), t !== null && (hl(t, e, i, r), po(t, e, i));
		},
		enqueueForceUpdate: function(e, t) {
			e = e._reactInternals;
			var n = pl(), r = ml(e), i = uo(n, r);
			i.tag = 2, t != null && (i.callback = t), t = fo(e, i, r), t !== null && (hl(t, e, r, n), po(t, e, r));
		}
	};
	function Es(e, t, n, r, i, a, o) {
		return e = e.stateNode, typeof e.shouldComponentUpdate == "function" ? e.shouldComponentUpdate(r, a, o) : t.prototype && t.prototype.isPureReactComponent ? !Rr(n, r) || !Rr(i, a) : !0;
	}
	function Ds(e, t, n) {
		var r = !1, i = ea, a = t.contextType;
		return typeof a == "object" && a ? a = no(a) : (i = ia(t) ? na : L.current, r = t.contextTypes, a = (r = r != null) ? ra(e, i) : ea), t = new t(n, a), e.memoizedState = t.state !== null && t.state !== void 0 ? t.state : null, t.updater = Ts, e.stateNode = t, t._reactInternals = e, r && (e = e.stateNode, e.__reactInternalMemoizedUnmaskedChildContext = i, e.__reactInternalMemoizedMaskedChildContext = a), t;
	}
	function Os(e, t, n, r) {
		e = t.state, typeof t.componentWillReceiveProps == "function" && t.componentWillReceiveProps(n, r), typeof t.UNSAFE_componentWillReceiveProps == "function" && t.UNSAFE_componentWillReceiveProps(n, r), t.state !== e && Ts.enqueueReplaceState(t, t.state, null);
	}
	function ks(e, t, n, r) {
		var i = e.stateNode;
		i.props = n, i.state = e.memoizedState, i.refs = {}, co(e);
		var a = t.contextType;
		typeof a == "object" && a ? i.context = no(a) : (a = ia(t) ? na : L.current, i.context = ra(e, a)), i.state = e.memoizedState, a = t.getDerivedStateFromProps, typeof a == "function" && (ws(e, t, a, n), i.state = e.memoizedState), typeof t.getDerivedStateFromProps == "function" || typeof i.getSnapshotBeforeUpdate == "function" || typeof i.UNSAFE_componentWillMount != "function" && typeof i.componentWillMount != "function" || (t = i.state, typeof i.componentWillMount == "function" && i.componentWillMount(), typeof i.UNSAFE_componentWillMount == "function" && i.UNSAFE_componentWillMount(), t !== i.state && Ts.enqueueReplaceState(i, i.state, null), ho(e, n, i, r), i.state = e.memoizedState), typeof i.componentDidMount == "function" && (e.flags |= 4194308);
	}
	function As(e, t) {
		try {
			var n = "", r = t;
			do
				n += me(r), r = r.return;
			while (r);
			var i = n;
		} catch (e) {
			i = "\nError generating stack: " + e.message + "\n" + e.stack;
		}
		return {
			value: e,
			source: t,
			stack: i,
			digest: null
		};
	}
	function js(e, t, n) {
		return {
			value: e,
			source: null,
			stack: n ?? null,
			digest: t ?? null
		};
	}
	function Ms(e, t) {
		try {
			console.error(t.value);
		} catch (e) {
			setTimeout(function() {
				throw e;
			});
		}
	}
	var Ns = typeof WeakMap == "function" ? WeakMap : Map;
	function Ps(e, t, n) {
		n = uo(-1, n), n.tag = 3, n.payload = { element: null };
		var r = t.value;
		return n.callback = function() {
			rl || (rl = !0, il = r), Ms(e, t);
		}, n;
	}
	function Fs(e, t, n) {
		n = uo(-1, n), n.tag = 3;
		var r = e.type.getDerivedStateFromError;
		if (typeof r == "function") {
			var i = t.value;
			n.payload = function() {
				return r(i);
			}, n.callback = function() {
				Ms(e, t);
			};
		}
		var a = e.stateNode;
		return a !== null && typeof a.componentDidCatch == "function" && (n.callback = function() {
			Ms(e, t), typeof r != "function" && (al === null ? al = /* @__PURE__ */ new Set([this]) : al.add(this));
			var n = t.stack;
			this.componentDidCatch(t.value, { componentStack: n === null ? "" : n });
		}), n;
	}
	function Is(e, t, n) {
		var r = e.pingCache;
		if (r === null) {
			r = e.pingCache = new Ns();
			var i = /* @__PURE__ */ new Set();
			r.set(t, i);
		} else i = r.get(t), i === void 0 && (i = /* @__PURE__ */ new Set(), r.set(t, i));
		i.has(n) || (i.add(n), e = zl.bind(null, e, t, n), t.then(e, e));
	}
	function Ls(e) {
		do {
			var t;
			if ((t = e.tag === 13) && (t = e.memoizedState, t = t === null ? !0 : t.dehydrated !== null), t) return e;
			e = e.return;
		} while (e !== null);
		return null;
	}
	function Rs(e, t, n, r, i) {
		return e.mode & 1 ? (e.flags |= 65536, e.lanes = i, e) : (e === t ? e.flags |= 65536 : (e.flags |= 128, n.flags |= 131072, n.flags &= -52805, n.tag === 1 && (n.alternate === null ? n.tag = 17 : (t = uo(-1, 1), t.tag = 2, fo(n, t, 1))), n.lanes |= 1), e);
	}
	var zs = S.ReactCurrentOwner, Bs = !1;
	function Vs(e, t, n, r) {
		t.child = e === null ? qa(t, null, n, r) : Ka(t, e.child, n, r);
	}
	function Hs(e, t, n, r, i) {
		n = n.render;
		var a = t.ref;
		return to(t, i), r = Lo(e, t, n, r, a, i), n = Ro(), e !== null && !Bs ? (t.updateQueue = e.updateQueue, t.flags &= -2053, e.lanes &= ~i, cc(e, t, i)) : (R && n && Da(t), t.flags |= 1, Vs(e, t, r, i), t.child);
	}
	function Us(e, t, n, r, i) {
		if (e === null) {
			var a = n.type;
			return typeof a == "function" && !ql(a) && a.defaultProps === void 0 && n.compare === null && n.defaultProps === void 0 ? (t.tag = 15, t.type = a, Ws(e, t, a, r, i)) : (e = Xl(n.type, null, r, t, t.mode, i), e.ref = t.ref, e.return = t, t.child = e);
		}
		if (a = e.child, (e.lanes & i) === 0) {
			var o = a.memoizedProps;
			if (n = n.compare, n = n === null ? Rr : n, n(o, r) && e.ref === t.ref) return cc(e, t, i);
		}
		return t.flags |= 1, e = Yl(a, r), e.ref = t.ref, e.return = t, t.child = e;
	}
	function Ws(e, t, n, r, i) {
		if (e !== null) {
			var a = e.memoizedProps;
			if (Rr(a, r) && e.ref === t.ref) if (Bs = !1, t.pendingProps = r = a, (e.lanes & i) !== 0) e.flags & 131072 && (Bs = !0);
			else return t.lanes = e.lanes, cc(e, t, i);
		}
		return qs(e, t, n, r, i);
	}
	function Gs(e, t, n) {
		var r = t.pendingProps, i = r.children, a = e === null ? null : e.memoizedState;
		if (r.mode === "hidden") if (!(t.mode & 1)) t.memoizedState = {
			baseLanes: 0,
			cachePool: null,
			transitions: null
		}, I(qc, Kc), Kc |= n;
		else {
			if (!(n & 1073741824)) return e = a === null ? n : a.baseLanes | n, t.lanes = t.childLanes = 1073741824, t.memoizedState = {
				baseLanes: e,
				cachePool: null,
				transitions: null
			}, t.updateQueue = null, I(qc, Kc), Kc |= e, null;
			t.memoizedState = {
				baseLanes: 0,
				cachePool: null,
				transitions: null
			}, r = a === null ? n : a.baseLanes, I(qc, Kc), Kc |= r;
		}
		else a === null ? r = n : (r = a.baseLanes | n, t.memoizedState = null), I(qc, Kc), Kc |= r;
		return Vs(e, t, i, n), t.child;
	}
	function Ks(e, t) {
		var n = t.ref;
		(e === null && n !== null || e !== null && e.ref !== n) && (t.flags |= 512, t.flags |= 2097152);
	}
	function qs(e, t, n, r, i) {
		var a = ia(n) ? na : L.current;
		return a = ra(t, a), to(t, i), n = Lo(e, t, n, r, a, i), r = Ro(), e !== null && !Bs ? (t.updateQueue = e.updateQueue, t.flags &= -2053, e.lanes &= ~i, cc(e, t, i)) : (R && r && Da(t), t.flags |= 1, Vs(e, t, n, i), t.child);
	}
	function Js(e, t, n, r, i) {
		if (ia(n)) {
			var a = !0;
			ca(t);
		} else a = !1;
		if (to(t, i), t.stateNode === null) sc(e, t), Ds(t, n, r), ks(t, n, r, i), r = !0;
		else if (e === null) {
			var o = t.stateNode, s = t.memoizedProps;
			o.props = s;
			var c = o.context, l = n.contextType;
			typeof l == "object" && l ? l = no(l) : (l = ia(n) ? na : L.current, l = ra(t, l));
			var u = n.getDerivedStateFromProps, d = typeof u == "function" || typeof o.getSnapshotBeforeUpdate == "function";
			d || typeof o.UNSAFE_componentWillReceiveProps != "function" && typeof o.componentWillReceiveProps != "function" || (s !== r || c !== l) && Os(t, o, r, l), so = !1;
			var f = t.memoizedState;
			o.state = f, ho(t, r, o, i), c = t.memoizedState, s !== r || f !== c || ta.current || so ? (typeof u == "function" && (ws(t, n, u, r), c = t.memoizedState), (s = so || Es(t, n, s, r, f, c, l)) ? (d || typeof o.UNSAFE_componentWillMount != "function" && typeof o.componentWillMount != "function" || (typeof o.componentWillMount == "function" && o.componentWillMount(), typeof o.UNSAFE_componentWillMount == "function" && o.UNSAFE_componentWillMount()), typeof o.componentDidMount == "function" && (t.flags |= 4194308)) : (typeof o.componentDidMount == "function" && (t.flags |= 4194308), t.memoizedProps = r, t.memoizedState = c), o.props = r, o.state = c, o.context = l, r = s) : (typeof o.componentDidMount == "function" && (t.flags |= 4194308), r = !1);
		} else {
			o = t.stateNode, lo(e, t), s = t.memoizedProps, l = t.type === t.elementType ? s : Cs(t.type, s), o.props = l, d = t.pendingProps, f = o.context, c = n.contextType, typeof c == "object" && c ? c = no(c) : (c = ia(n) ? na : L.current, c = ra(t, c));
			var p = n.getDerivedStateFromProps;
			(u = typeof p == "function" || typeof o.getSnapshotBeforeUpdate == "function") || typeof o.UNSAFE_componentWillReceiveProps != "function" && typeof o.componentWillReceiveProps != "function" || (s !== d || f !== c) && Os(t, o, r, c), so = !1, f = t.memoizedState, o.state = f, ho(t, r, o, i);
			var m = t.memoizedState;
			s !== d || f !== m || ta.current || so ? (typeof p == "function" && (ws(t, n, p, r), m = t.memoizedState), (l = so || Es(t, n, l, r, f, m, c) || !1) ? (u || typeof o.UNSAFE_componentWillUpdate != "function" && typeof o.componentWillUpdate != "function" || (typeof o.componentWillUpdate == "function" && o.componentWillUpdate(r, m, c), typeof o.UNSAFE_componentWillUpdate == "function" && o.UNSAFE_componentWillUpdate(r, m, c)), typeof o.componentDidUpdate == "function" && (t.flags |= 4), typeof o.getSnapshotBeforeUpdate == "function" && (t.flags |= 1024)) : (typeof o.componentDidUpdate != "function" || s === e.memoizedProps && f === e.memoizedState || (t.flags |= 4), typeof o.getSnapshotBeforeUpdate != "function" || s === e.memoizedProps && f === e.memoizedState || (t.flags |= 1024), t.memoizedProps = r, t.memoizedState = m), o.props = r, o.state = m, o.context = c, r = l) : (typeof o.componentDidUpdate != "function" || s === e.memoizedProps && f === e.memoizedState || (t.flags |= 4), typeof o.getSnapshotBeforeUpdate != "function" || s === e.memoizedProps && f === e.memoizedState || (t.flags |= 1024), r = !1);
		}
		return Ys(e, t, n, r, a, i);
	}
	function Ys(e, t, n, r, i, a) {
		Ks(e, t);
		var o = (t.flags & 128) != 0;
		if (!r && !o) return i && la(t, n, !1), cc(e, t, a);
		r = t.stateNode, zs.current = t;
		var s = o && typeof n.getDerivedStateFromError != "function" ? null : r.render();
		return t.flags |= 1, e !== null && o ? (t.child = Ka(t, e.child, null, a), t.child = Ka(t, null, s, a)) : Vs(e, t, s, a), t.memoizedState = r.state, i && la(t, n, !0), t.child;
	}
	function Xs(e) {
		var t = e.stateNode;
		t.pendingContext ? oa(e, t.pendingContext, t.pendingContext !== t.context) : t.context && oa(e, t.context, !1), So(e, t.containerInfo);
	}
	function Zs(e, t, n, r, i) {
		return za(), Ba(i), t.flags |= 256, Vs(e, t, n, r), t.child;
	}
	var Qs = {
		dehydrated: null,
		treeContext: null,
		retryLane: 0
	};
	function $s(e) {
		return {
			baseLanes: e,
			cachePool: null,
			transitions: null
		};
	}
	function ec(e, t, n) {
		var r = t.pendingProps, i = z.current, a = !1, o = (t.flags & 128) != 0, s;
		if ((s = o) || (s = e !== null && e.memoizedState === null ? !1 : (i & 2) != 0), s ? (a = !0, t.flags &= -129) : (e === null || e.memoizedState !== null) && (i |= 1), I(z, i & 1), e === null) return Fa(t), e = t.memoizedState, e !== null && (e = e.dehydrated, e !== null) ? (t.mode & 1 ? e.data === "$!" ? t.lanes = 8 : t.lanes = 1073741824 : t.lanes = 1, null) : (o = r.children, e = r.fallback, a ? (r = t.mode, a = t.child, o = {
			mode: "hidden",
			children: o
		}, !(r & 1) && a !== null ? (a.childLanes = 0, a.pendingProps = o) : a = Ql(o, r, 0, null), e = Zl(e, r, n, null), a.return = t, e.return = t, a.sibling = e, t.child = a, t.child.memoizedState = $s(n), t.memoizedState = Qs, e) : tc(t, o));
		if (i = e.memoizedState, i !== null && (s = i.dehydrated, s !== null)) return rc(e, t, o, r, s, i, n);
		if (a) {
			a = r.fallback, o = t.mode, i = e.child, s = i.sibling;
			var c = {
				mode: "hidden",
				children: r.children
			};
			return !(o & 1) && t.child !== i ? (r = t.child, r.childLanes = 0, r.pendingProps = c, t.deletions = null) : (r = Yl(i, c), r.subtreeFlags = i.subtreeFlags & 14680064), s === null ? (a = Zl(a, o, n, null), a.flags |= 2) : a = Yl(s, a), a.return = t, r.return = t, r.sibling = a, t.child = r, r = a, a = t.child, o = e.child.memoizedState, o = o === null ? $s(n) : {
				baseLanes: o.baseLanes | n,
				cachePool: null,
				transitions: o.transitions
			}, a.memoizedState = o, a.childLanes = e.childLanes & ~n, t.memoizedState = Qs, r;
		}
		return a = e.child, e = a.sibling, r = Yl(a, {
			mode: "visible",
			children: r.children
		}), !(t.mode & 1) && (r.lanes = n), r.return = t, r.sibling = null, e !== null && (n = t.deletions, n === null ? (t.deletions = [e], t.flags |= 16) : n.push(e)), t.child = r, t.memoizedState = null, r;
	}
	function tc(e, t) {
		return t = Ql({
			mode: "visible",
			children: t
		}, e.mode, 0, null), t.return = e, e.child = t;
	}
	function nc(e, t, n, r) {
		return r !== null && Ba(r), Ka(t, e.child, null, n), e = tc(t, t.pendingProps.children), e.flags |= 2, t.memoizedState = null, e;
	}
	function rc(e, t, n, i, a, o, s) {
		if (n) return t.flags & 256 ? (t.flags &= -257, i = js(Error(r(422))), nc(e, t, s, i)) : t.memoizedState === null ? (o = i.fallback, a = t.mode, i = Ql({
			mode: "visible",
			children: i.children
		}, a, 0, null), o = Zl(o, a, s, null), o.flags |= 2, i.return = t, o.return = t, i.sibling = o, t.child = i, t.mode & 1 && Ka(t, e.child, null, s), t.child.memoizedState = $s(s), t.memoizedState = Qs, o) : (t.child = e.child, t.flags |= 128, null);
		if (!(t.mode & 1)) return nc(e, t, s, null);
		if (a.data === "$!") {
			if (i = a.nextSibling && a.nextSibling.dataset, i) var c = i.dgst;
			return i = c, o = Error(r(419)), i = js(o, i, void 0), nc(e, t, s, i);
		}
		if (c = (s & e.childLanes) !== 0, Bs || c) {
			if (i = Y, i !== null) {
				switch (s & -s) {
					case 4:
						a = 2;
						break;
					case 16:
						a = 8;
						break;
					case 64:
					case 128:
					case 256:
					case 512:
					case 1024:
					case 2048:
					case 4096:
					case 8192:
					case 16384:
					case 32768:
					case 65536:
					case 131072:
					case 262144:
					case 524288:
					case 1048576:
					case 2097152:
					case 4194304:
					case 8388608:
					case 16777216:
					case 33554432:
					case 67108864:
						a = 32;
						break;
					case 536870912:
						a = 268435456;
						break;
					default: a = 0;
				}
				a = (a & (i.suspendedLanes | s)) === 0 ? a : 0, a !== 0 && a !== o.retryLane && (o.retryLane = a, oo(e, a), hl(i, e, a, -1));
			}
			return kl(), i = js(Error(r(421))), nc(e, t, s, i);
		}
		return a.data === "$?" ? (t.flags |= 128, t.child = e.child, t = Vl.bind(null, e), a._reactRetry = t, null) : (e = o.treeContext, Aa = Ri(a.nextSibling), ka = t, R = !0, ja = null, e !== null && (ba[xa++] = Ca, ba[xa++] = wa, ba[xa++] = Sa, Ca = e.id, wa = e.overflow, Sa = t), t = tc(t, i.children), t.flags |= 4096, t);
	}
	function ic(e, t, n) {
		e.lanes |= t;
		var r = e.alternate;
		r !== null && (r.lanes |= t), eo(e.return, t, n);
	}
	function ac(e, t, n, r, i) {
		var a = e.memoizedState;
		a === null ? e.memoizedState = {
			isBackwards: t,
			rendering: null,
			renderingStartTime: 0,
			last: r,
			tail: n,
			tailMode: i
		} : (a.isBackwards = t, a.rendering = null, a.renderingStartTime = 0, a.last = r, a.tail = n, a.tailMode = i);
	}
	function oc(e, t, n) {
		var r = t.pendingProps, i = r.revealOrder, a = r.tail;
		if (Vs(e, t, r.children, n), r = z.current, r & 2) r = r & 1 | 2, t.flags |= 128;
		else {
			if (e !== null && e.flags & 128) a: for (e = t.child; e !== null;) {
				if (e.tag === 13) e.memoizedState !== null && ic(e, n, t);
				else if (e.tag === 19) ic(e, n, t);
				else if (e.child !== null) {
					e.child.return = e, e = e.child;
					continue;
				}
				if (e === t) break a;
				for (; e.sibling === null;) {
					if (e.return === null || e.return === t) break a;
					e = e.return;
				}
				e.sibling.return = e.return, e = e.sibling;
			}
			r &= 1;
		}
		if (I(z, r), !(t.mode & 1)) t.memoizedState = null;
		else switch (i) {
			case "forwards":
				for (n = t.child, i = null; n !== null;) e = n.alternate, e !== null && Eo(e) === null && (i = n), n = n.sibling;
				n = i, n === null ? (i = t.child, t.child = null) : (i = n.sibling, n.sibling = null), ac(t, !1, i, n, a);
				break;
			case "backwards":
				for (n = null, i = t.child, t.child = null; i !== null;) {
					if (e = i.alternate, e !== null && Eo(e) === null) {
						t.child = i;
						break;
					}
					e = i.sibling, i.sibling = n, n = i, i = e;
				}
				ac(t, !0, n, null, a);
				break;
			case "together":
				ac(t, !1, null, null, void 0);
				break;
			default: t.memoizedState = null;
		}
		return t.child;
	}
	function sc(e, t) {
		!(t.mode & 1) && e !== null && (e.alternate = null, t.alternate = null, t.flags |= 2);
	}
	function cc(e, t, n) {
		if (e !== null && (t.dependencies = e.dependencies), Yc |= t.lanes, (n & t.childLanes) === 0) return null;
		if (e !== null && t.child !== e.child) throw Error(r(153));
		if (t.child !== null) {
			for (e = t.child, n = Yl(e, e.pendingProps), t.child = n, n.return = t; e.sibling !== null;) e = e.sibling, n = n.sibling = Yl(e, e.pendingProps), n.return = t;
			n.sibling = null;
		}
		return t.child;
	}
	function lc(e, t, n) {
		switch (t.tag) {
			case 3:
				Xs(t), za();
				break;
			case 5:
				wo(t);
				break;
			case 1:
				ia(t.type) && ca(t);
				break;
			case 4:
				So(t, t.stateNode.containerInfo);
				break;
			case 10:
				var r = t.type._context, i = t.memoizedProps.value;
				I(Ja, r._currentValue), r._currentValue = i;
				break;
			case 13:
				if (r = t.memoizedState, r !== null) return r.dehydrated === null ? (n & t.child.childLanes) === 0 ? (I(z, z.current & 1), e = cc(e, t, n), e === null ? null : e.sibling) : ec(e, t, n) : (I(z, z.current & 1), t.flags |= 128, null);
				I(z, z.current & 1);
				break;
			case 19:
				if (r = (n & t.childLanes) !== 0, e.flags & 128) {
					if (r) return oc(e, t, n);
					t.flags |= 128;
				}
				if (i = t.memoizedState, i !== null && (i.rendering = null, i.tail = null, i.lastEffect = null), I(z, z.current), r) break;
				return null;
			case 22:
			case 23: return t.lanes = 0, Gs(e, t, n);
		}
		return cc(e, t, n);
	}
	var uc = function(e, t) {
		for (var n = t.child; n !== null;) {
			if (n.tag === 5 || n.tag === 6) e.appendChild(n.stateNode);
			else if (n.tag !== 4 && n.child !== null) {
				n.child.return = n, n = n.child;
				continue;
			}
			if (n === t) break;
			for (; n.sibling === null;) {
				if (n.return === null || n.return === t) return;
				n = n.return;
			}
			n.sibling.return = n.return, n = n.sibling;
		}
	}, dc = function(e, t, n, r) {
		var i = e.memoizedProps;
		if (i !== r) {
			e = t.stateNode, xo(vo.current);
			var o = null;
			switch (n) {
				case "input":
					i = xe(e, i), r = xe(e, r), o = [];
					break;
				case "select":
					i = k({}, i, { value: void 0 }), r = k({}, r, { value: void 0 }), o = [];
					break;
				case "textarea":
					i = ke(e, i), r = ke(e, r), o = [];
					break;
				default: typeof i.onClick != "function" && typeof r.onClick == "function" && (e.onclick = Oi);
			}
			Ue(n, r);
			var s;
			for (u in n = null, i) if (!r.hasOwnProperty(u) && i.hasOwnProperty(u) && i[u] != null) if (u === "style") {
				var c = i[u];
				for (s in c) c.hasOwnProperty(s) && (n ||= {}, n[s] = "");
			} else u !== "dangerouslySetInnerHTML" && u !== "children" && u !== "suppressContentEditableWarning" && u !== "suppressHydrationWarning" && u !== "autoFocus" && (a.hasOwnProperty(u) ? o ||= [] : (o ||= []).push(u, null));
			for (u in r) {
				var l = r[u];
				if (c = i?.[u], r.hasOwnProperty(u) && l !== c && (l != null || c != null)) if (u === "style") if (c) {
					for (s in c) !c.hasOwnProperty(s) || l && l.hasOwnProperty(s) || (n ||= {}, n[s] = "");
					for (s in l) l.hasOwnProperty(s) && c[s] !== l[s] && (n ||= {}, n[s] = l[s]);
				} else n || (o ||= [], o.push(u, n)), n = l;
				else u === "dangerouslySetInnerHTML" ? (l = l ? l.__html : void 0, c = c ? c.__html : void 0, l != null && c !== l && (o ||= []).push(u, l)) : u === "children" ? typeof l != "string" && typeof l != "number" || (o ||= []).push(u, "" + l) : u !== "suppressContentEditableWarning" && u !== "suppressHydrationWarning" && (a.hasOwnProperty(u) ? (l != null && u === "onScroll" && P("scroll", e), o || c === l || (o = [])) : (o ||= []).push(u, l));
			}
			n && (o ||= []).push("style", n);
			var u = o;
			(t.updateQueue = u) && (t.flags |= 4);
		}
	}, fc = function(e, t, n, r) {
		n !== r && (t.flags |= 4);
	};
	function pc(e, t) {
		if (!R) switch (e.tailMode) {
			case "hidden":
				t = e.tail;
				for (var n = null; t !== null;) t.alternate !== null && (n = t), t = t.sibling;
				n === null ? e.tail = null : n.sibling = null;
				break;
			case "collapsed":
				n = e.tail;
				for (var r = null; n !== null;) n.alternate !== null && (r = n), n = n.sibling;
				r === null ? t || e.tail === null ? e.tail = null : e.tail.sibling = null : r.sibling = null;
		}
	}
	function W(e) {
		var t = e.alternate !== null && e.alternate.child === e.child, n = 0, r = 0;
		if (t) for (var i = e.child; i !== null;) n |= i.lanes | i.childLanes, r |= i.subtreeFlags & 14680064, r |= i.flags & 14680064, i.return = e, i = i.sibling;
		else for (i = e.child; i !== null;) n |= i.lanes | i.childLanes, r |= i.subtreeFlags, r |= i.flags, i.return = e, i = i.sibling;
		return e.subtreeFlags |= r, e.childLanes = n, t;
	}
	function mc(e, t, n) {
		var i = t.pendingProps;
		switch (Oa(t), t.tag) {
			case 2:
			case 16:
			case 15:
			case 0:
			case 11:
			case 7:
			case 8:
			case 12:
			case 9:
			case 14: return W(t), null;
			case 1: return ia(t.type) && aa(), W(t), null;
			case 3: return i = t.stateNode, Co(), F(ta), F(L), Oo(), i.pendingContext && (i.context = i.pendingContext, i.pendingContext = null), (e === null || e.child === null) && (La(t) ? t.flags |= 4 : e === null || e.memoizedState.isDehydrated && !(t.flags & 256) || (t.flags |= 1024, ja !== null && (yl(ja), ja = null))), W(t), null;
			case 5:
				To(t);
				var o = xo(bo.current);
				if (n = t.type, e !== null && t.stateNode != null) dc(e, t, n, i, o), e.ref !== t.ref && (t.flags |= 512, t.flags |= 2097152);
				else {
					if (!i) {
						if (t.stateNode === null) throw Error(r(166));
						return W(t), null;
					}
					if (e = xo(vo.current), La(t)) {
						i = t.stateNode, n = t.type;
						var s = t.memoizedProps;
						switch (i[Vi] = t, i[Hi] = s, e = (t.mode & 1) != 0, n) {
							case "dialog":
								P("cancel", i), P("close", i);
								break;
							case "iframe":
							case "object":
							case "embed":
								P("load", i);
								break;
							case "video":
							case "audio":
								for (o = 0; o < di.length; o++) P(di[o], i);
								break;
							case "source":
								P("error", i);
								break;
							case "img":
							case "image":
							case "link":
								P("error", i), P("load", i);
								break;
							case "details":
								P("toggle", i);
								break;
							case "input":
								Se(i, s), P("invalid", i);
								break;
							case "select":
								i._wrapperState = { wasMultiple: !!s.multiple }, P("invalid", i);
								break;
							case "textarea": Ae(i, s), P("invalid", i);
						}
						for (var c in Ue(n, s), o = null, s) if (s.hasOwnProperty(c)) {
							var l = s[c];
							c === "children" ? typeof l == "string" ? i.textContent !== l && (!0 !== s.suppressHydrationWarning && Di(i.textContent, l, e), o = ["children", l]) : typeof l == "number" && i.textContent !== "" + l && (!0 !== s.suppressHydrationWarning && Di(i.textContent, l, e), o = ["children", "" + l]) : a.hasOwnProperty(c) && l != null && c === "onScroll" && P("scroll", i);
						}
						switch (n) {
							case "input":
								ye(i), Te(i, s, !0);
								break;
							case "textarea":
								ye(i), Me(i);
								break;
							case "select":
							case "option": break;
							default: typeof s.onClick == "function" && (i.onclick = Oi);
						}
						i = o, t.updateQueue = i, i !== null && (t.flags |= 4);
					} else {
						c = o.nodeType === 9 ? o : o.ownerDocument, e === "http://www.w3.org/1999/xhtml" && (e = Ne(n)), e === "http://www.w3.org/1999/xhtml" ? n === "script" ? (e = c.createElement("div"), e.innerHTML = "<script><\/script>", e = e.removeChild(e.firstChild)) : typeof i.is == "string" ? e = c.createElement(n, { is: i.is }) : (e = c.createElement(n), n === "select" && (c = e, i.multiple ? c.multiple = !0 : i.size && (c.size = i.size))) : e = c.createElementNS(e, n), e[Vi] = t, e[Hi] = i, uc(e, t, !1, !1), t.stateNode = e;
						a: {
							switch (c = We(n, i), n) {
								case "dialog":
									P("cancel", e), P("close", e), o = i;
									break;
								case "iframe":
								case "object":
								case "embed":
									P("load", e), o = i;
									break;
								case "video":
								case "audio":
									for (o = 0; o < di.length; o++) P(di[o], e);
									o = i;
									break;
								case "source":
									P("error", e), o = i;
									break;
								case "img":
								case "image":
								case "link":
									P("error", e), P("load", e), o = i;
									break;
								case "details":
									P("toggle", e), o = i;
									break;
								case "input":
									Se(e, i), o = xe(e, i), P("invalid", e);
									break;
								case "option":
									o = i;
									break;
								case "select":
									e._wrapperState = { wasMultiple: !!i.multiple }, o = k({}, i, { value: void 0 }), P("invalid", e);
									break;
								case "textarea":
									Ae(e, i), o = ke(e, i), P("invalid", e);
									break;
								default: o = i;
							}
							for (s in Ue(n, o), l = o, l) if (l.hasOwnProperty(s)) {
								var u = l[s];
								s === "style" ? Ve(e, u) : s === "dangerouslySetInnerHTML" ? (u = u ? u.__html : void 0, u != null && Ie(e, u)) : s === "children" ? typeof u == "string" ? (n !== "textarea" || u !== "") && Le(e, u) : typeof u == "number" && Le(e, "" + u) : s !== "suppressContentEditableWarning" && s !== "suppressHydrationWarning" && s !== "autoFocus" && (a.hasOwnProperty(s) ? u != null && s === "onScroll" && P("scroll", e) : u != null && ee(e, s, u, c));
							}
							switch (n) {
								case "input":
									ye(e), Te(e, i, !1);
									break;
								case "textarea":
									ye(e), Me(e);
									break;
								case "option":
									i.value != null && e.setAttribute("value", "" + A(i.value));
									break;
								case "select":
									e.multiple = !!i.multiple, s = i.value, s == null ? i.defaultValue != null && Oe(e, !!i.multiple, i.defaultValue, !0) : Oe(e, !!i.multiple, s, !1);
									break;
								default: typeof o.onClick == "function" && (e.onclick = Oi);
							}
							switch (n) {
								case "button":
								case "input":
								case "select":
								case "textarea":
									i = !!i.autoFocus;
									break a;
								case "img":
									i = !0;
									break a;
								default: i = !1;
							}
						}
						i && (t.flags |= 4);
					}
					t.ref !== null && (t.flags |= 512, t.flags |= 2097152);
				}
				return W(t), null;
			case 6:
				if (e && t.stateNode != null) fc(e, t, e.memoizedProps, i);
				else {
					if (typeof i != "string" && t.stateNode === null) throw Error(r(166));
					if (n = xo(bo.current), xo(vo.current), La(t)) {
						if (i = t.stateNode, n = t.memoizedProps, i[Vi] = t, (s = i.nodeValue !== n) && (e = ka, e !== null)) switch (e.tag) {
							case 3:
								Di(i.nodeValue, n, (e.mode & 1) != 0);
								break;
							case 5: !0 !== e.memoizedProps.suppressHydrationWarning && Di(i.nodeValue, n, (e.mode & 1) != 0);
						}
						s && (t.flags |= 4);
					} else i = (n.nodeType === 9 ? n : n.ownerDocument).createTextNode(i), i[Vi] = t, t.stateNode = i;
				}
				return W(t), null;
			case 13:
				if (F(z), i = t.memoizedState, e === null || e.memoizedState !== null && e.memoizedState.dehydrated !== null) {
					if (R && Aa !== null && t.mode & 1 && !(t.flags & 128)) Ra(), za(), t.flags |= 98560, s = !1;
					else if (s = La(t), i !== null && i.dehydrated !== null) {
						if (e === null) {
							if (!s) throw Error(r(318));
							if (s = t.memoizedState, s = s === null ? null : s.dehydrated, !s) throw Error(r(317));
							s[Vi] = t;
						} else za(), !(t.flags & 128) && (t.memoizedState = null), t.flags |= 4;
						W(t), s = !1;
					} else ja !== null && (yl(ja), ja = null), s = !0;
					if (!s) return t.flags & 65536 ? t : null;
				}
				return t.flags & 128 ? (t.lanes = n, t) : (i = i !== null, i !== (e !== null && e.memoizedState !== null) && i && (t.child.flags |= 8192, t.mode & 1 && (e === null || z.current & 1 ? Q === 0 && (Q = 3) : kl())), t.updateQueue !== null && (t.flags |= 4), W(t), null);
			case 4: return Co(), e === null && _i(t.stateNode.containerInfo), W(t), null;
			case 10: return $a(t.type._context), W(t), null;
			case 17: return ia(t.type) && aa(), W(t), null;
			case 19:
				if (F(z), s = t.memoizedState, s === null) return W(t), null;
				if (i = (t.flags & 128) != 0, c = s.rendering, c === null) if (i) pc(s, !1);
				else {
					if (Q !== 0 || e !== null && e.flags & 128) for (e = t.child; e !== null;) {
						if (c = Eo(e), c !== null) {
							for (t.flags |= 128, pc(s, !1), i = c.updateQueue, i !== null && (t.updateQueue = i, t.flags |= 4), t.subtreeFlags = 0, i = n, n = t.child; n !== null;) s = n, e = i, s.flags &= 14680066, c = s.alternate, c === null ? (s.childLanes = 0, s.lanes = e, s.child = null, s.subtreeFlags = 0, s.memoizedProps = null, s.memoizedState = null, s.updateQueue = null, s.dependencies = null, s.stateNode = null) : (s.childLanes = c.childLanes, s.lanes = c.lanes, s.child = c.child, s.subtreeFlags = 0, s.deletions = null, s.memoizedProps = c.memoizedProps, s.memoizedState = c.memoizedState, s.updateQueue = c.updateQueue, s.type = c.type, e = c.dependencies, s.dependencies = e === null ? null : {
								lanes: e.lanes,
								firstContext: e.firstContext
							}), n = n.sibling;
							return I(z, z.current & 1 | 2), t.child;
						}
						e = e.sibling;
					}
					s.tail !== null && M() > tl && (t.flags |= 128, i = !0, pc(s, !1), t.lanes = 4194304);
				}
				else {
					if (!i) if (e = Eo(c), e !== null) {
						if (t.flags |= 128, i = !0, n = e.updateQueue, n !== null && (t.updateQueue = n, t.flags |= 4), pc(s, !0), s.tail === null && s.tailMode === "hidden" && !c.alternate && !R) return W(t), null;
					} else 2 * M() - s.renderingStartTime > tl && n !== 1073741824 && (t.flags |= 128, i = !0, pc(s, !1), t.lanes = 4194304);
					s.isBackwards ? (c.sibling = t.child, t.child = c) : (n = s.last, n === null ? t.child = c : n.sibling = c, s.last = c);
				}
				return s.tail === null ? (W(t), null) : (t = s.tail, s.rendering = t, s.tail = t.sibling, s.renderingStartTime = M(), t.sibling = null, n = z.current, I(z, i ? n & 1 | 2 : n & 1), t);
			case 22:
			case 23: return Tl(), i = t.memoizedState !== null, e !== null && e.memoizedState !== null !== i && (t.flags |= 8192), i && t.mode & 1 ? Kc & 1073741824 && (W(t), t.subtreeFlags & 6 && (t.flags |= 8192)) : W(t), null;
			case 24: return null;
			case 25: return null;
		}
		throw Error(r(156, t.tag));
	}
	function hc(e, t) {
		switch (Oa(t), t.tag) {
			case 1: return ia(t.type) && aa(), e = t.flags, e & 65536 ? (t.flags = e & -65537 | 128, t) : null;
			case 3: return Co(), F(ta), F(L), Oo(), e = t.flags, e & 65536 && !(e & 128) ? (t.flags = e & -65537 | 128, t) : null;
			case 5: return To(t), null;
			case 13:
				if (F(z), e = t.memoizedState, e !== null && e.dehydrated !== null) {
					if (t.alternate === null) throw Error(r(340));
					za();
				}
				return e = t.flags, e & 65536 ? (t.flags = e & -65537 | 128, t) : null;
			case 19: return F(z), null;
			case 4: return Co(), null;
			case 10: return $a(t.type._context), null;
			case 22:
			case 23: return Tl(), null;
			case 24: return null;
			default: return null;
		}
	}
	var gc = !1, G = !1, _c = typeof WeakSet == "function" ? WeakSet : Set, K = null;
	function vc(e, t) {
		var n = e.ref;
		if (n !== null) if (typeof n == "function") try {
			n(null);
		} catch (n) {
			$(e, t, n);
		}
		else n.current = null;
	}
	function yc(e, t, n) {
		try {
			n();
		} catch (n) {
			$(e, t, n);
		}
	}
	var bc = !1;
	function xc(e, t) {
		if (ki = xn, e = Hr(), Ur(e)) {
			if ("selectionStart" in e) var n = {
				start: e.selectionStart,
				end: e.selectionEnd
			};
			else a: {
				n = (n = e.ownerDocument) && n.defaultView || window;
				var i = n.getSelection && n.getSelection();
				if (i && i.rangeCount !== 0) {
					n = i.anchorNode;
					var a = i.anchorOffset, o = i.focusNode;
					i = i.focusOffset;
					try {
						n.nodeType, o.nodeType;
					} catch {
						n = null;
						break a;
					}
					var s = 0, c = -1, l = -1, u = 0, d = 0, f = e, p = null;
					b: for (;;) {
						for (var m; f !== n || a !== 0 && f.nodeType !== 3 || (c = s + a), f !== o || i !== 0 && f.nodeType !== 3 || (l = s + i), f.nodeType === 3 && (s += f.nodeValue.length), (m = f.firstChild) !== null;) p = f, f = m;
						for (;;) {
							if (f === e) break b;
							if (p === n && ++u === a && (c = s), p === o && ++d === i && (l = s), (m = f.nextSibling) !== null) break;
							f = p, p = f.parentNode;
						}
						f = m;
					}
					n = c === -1 || l === -1 ? null : {
						start: c,
						end: l
					};
				} else n = null;
			}
			n ||= {
				start: 0,
				end: 0
			};
		} else n = null;
		for (Ai = {
			focusedElem: e,
			selectionRange: n
		}, xn = !1, K = t; K !== null;) if (t = K, e = t.child, t.subtreeFlags & 1028 && e !== null) e.return = t, K = e;
		else for (; K !== null;) {
			t = K;
			try {
				var h = t.alternate;
				if (t.flags & 1024) switch (t.tag) {
					case 0:
					case 11:
					case 15: break;
					case 1:
						if (h !== null) {
							var g = h.memoizedProps, _ = h.memoizedState, v = t.stateNode;
							v.__reactInternalSnapshotBeforeUpdate = v.getSnapshotBeforeUpdate(t.elementType === t.type ? g : Cs(t.type, g), _);
						}
						break;
					case 3:
						var y = t.stateNode.containerInfo;
						y.nodeType === 1 ? y.textContent = "" : y.nodeType === 9 && y.documentElement && y.removeChild(y.documentElement);
						break;
					case 5:
					case 6:
					case 4:
					case 17: break;
					default: throw Error(r(163));
				}
			} catch (e) {
				$(t, t.return, e);
			}
			if (e = t.sibling, e !== null) {
				e.return = t.return, K = e;
				break;
			}
			K = t.return;
		}
		return h = bc, bc = !1, h;
	}
	function Sc(e, t, n) {
		var r = t.updateQueue;
		if (r = r === null ? null : r.lastEffect, r !== null) {
			var i = r = r.next;
			do {
				if ((i.tag & e) === e) {
					var a = i.destroy;
					i.destroy = void 0, a !== void 0 && yc(t, n, a);
				}
				i = i.next;
			} while (i !== r);
		}
	}
	function Cc(e, t) {
		if (t = t.updateQueue, t = t === null ? null : t.lastEffect, t !== null) {
			var n = t = t.next;
			do {
				if ((n.tag & e) === e) {
					var r = n.create;
					n.destroy = r();
				}
				n = n.next;
			} while (n !== t);
		}
	}
	function wc(e) {
		var t = e.ref;
		if (t !== null) {
			var n = e.stateNode;
			switch (e.tag) {
				case 5:
					e = n;
					break;
				default: e = n;
			}
			typeof t == "function" ? t(e) : t.current = e;
		}
	}
	function Tc(e) {
		var t = e.alternate;
		t !== null && (e.alternate = null, Tc(t)), e.child = null, e.deletions = null, e.sibling = null, e.tag === 5 && (t = e.stateNode, t !== null && (delete t[Vi], delete t[Hi], delete t[Wi], delete t[Gi], delete t[Ki])), e.stateNode = null, e.return = null, e.dependencies = null, e.memoizedProps = null, e.memoizedState = null, e.pendingProps = null, e.stateNode = null, e.updateQueue = null;
	}
	function Ec(e) {
		return e.tag === 5 || e.tag === 3 || e.tag === 4;
	}
	function Dc(e) {
		a: for (;;) {
			for (; e.sibling === null;) {
				if (e.return === null || Ec(e.return)) return null;
				e = e.return;
			}
			for (e.sibling.return = e.return, e = e.sibling; e.tag !== 5 && e.tag !== 6 && e.tag !== 18;) {
				if (e.flags & 2 || e.child === null || e.tag === 4) continue a;
				e.child.return = e, e = e.child;
			}
			if (!(e.flags & 2)) return e.stateNode;
		}
	}
	function Oc(e, t, n) {
		var r = e.tag;
		if (r === 5 || r === 6) e = e.stateNode, t ? n.nodeType === 8 ? n.parentNode.insertBefore(e, t) : n.insertBefore(e, t) : (n.nodeType === 8 ? (t = n.parentNode, t.insertBefore(e, n)) : (t = n, t.appendChild(e)), n = n._reactRootContainer, n != null || t.onclick !== null || (t.onclick = Oi));
		else if (r !== 4 && (e = e.child, e !== null)) for (Oc(e, t, n), e = e.sibling; e !== null;) Oc(e, t, n), e = e.sibling;
	}
	function kc(e, t, n) {
		var r = e.tag;
		if (r === 5 || r === 6) e = e.stateNode, t ? n.insertBefore(e, t) : n.appendChild(e);
		else if (r !== 4 && (e = e.child, e !== null)) for (kc(e, t, n), e = e.sibling; e !== null;) kc(e, t, n), e = e.sibling;
	}
	var q = null, Ac = !1;
	function jc(e, t, n) {
		for (n = n.child; n !== null;) Mc(e, t, n), n = n.sibling;
	}
	function Mc(e, t, n) {
		if (jt && typeof jt.onCommitFiberUnmount == "function") try {
			jt.onCommitFiberUnmount(At, n);
		} catch {}
		switch (n.tag) {
			case 5: G || vc(n, t);
			case 6:
				var r = q, i = Ac;
				q = null, jc(e, t, n), q = r, Ac = i, q !== null && (Ac ? (e = q, n = n.stateNode, e.nodeType === 8 ? e.parentNode.removeChild(n) : e.removeChild(n)) : q.removeChild(n.stateNode));
				break;
			case 18:
				q !== null && (Ac ? (e = q, n = n.stateNode, e.nodeType === 8 ? Li(e.parentNode, n) : e.nodeType === 1 && Li(e, n), yn(e)) : Li(q, n.stateNode));
				break;
			case 4:
				r = q, i = Ac, q = n.stateNode.containerInfo, Ac = !0, jc(e, t, n), q = r, Ac = i;
				break;
			case 0:
			case 11:
			case 14:
			case 15:
				if (!G && (r = n.updateQueue, r !== null && (r = r.lastEffect, r !== null))) {
					i = r = r.next;
					do {
						var a = i, o = a.destroy;
						a = a.tag, o !== void 0 && (a & 2 || a & 4) && yc(n, t, o), i = i.next;
					} while (i !== r);
				}
				jc(e, t, n);
				break;
			case 1:
				if (!G && (vc(n, t), r = n.stateNode, typeof r.componentWillUnmount == "function")) try {
					r.props = n.memoizedProps, r.state = n.memoizedState, r.componentWillUnmount();
				} catch (e) {
					$(n, t, e);
				}
				jc(e, t, n);
				break;
			case 21:
				jc(e, t, n);
				break;
			case 22:
				n.mode & 1 ? (G = (r = G) || n.memoizedState !== null, jc(e, t, n), G = r) : jc(e, t, n);
				break;
			default: jc(e, t, n);
		}
	}
	function Nc(e) {
		var t = e.updateQueue;
		if (t !== null) {
			e.updateQueue = null;
			var n = e.stateNode;
			n === null && (n = e.stateNode = new _c()), t.forEach(function(t) {
				var r = Hl.bind(null, e, t);
				n.has(t) || (n.add(t), t.then(r, r));
			});
		}
	}
	function Pc(e, t) {
		var n = t.deletions;
		if (n !== null) for (var i = 0; i < n.length; i++) {
			var a = n[i];
			try {
				var o = e, s = t, c = s;
				a: for (; c !== null;) {
					switch (c.tag) {
						case 5:
							q = c.stateNode, Ac = !1;
							break a;
						case 3:
							q = c.stateNode.containerInfo, Ac = !0;
							break a;
						case 4:
							q = c.stateNode.containerInfo, Ac = !0;
							break a;
					}
					c = c.return;
				}
				if (q === null) throw Error(r(160));
				Mc(o, s, a), q = null, Ac = !1;
				var l = a.alternate;
				l !== null && (l.return = null), a.return = null;
			} catch (e) {
				$(a, t, e);
			}
		}
		if (t.subtreeFlags & 12854) for (t = t.child; t !== null;) Fc(t, e), t = t.sibling;
	}
	function Fc(e, t) {
		var n = e.alternate, i = e.flags;
		switch (e.tag) {
			case 0:
			case 11:
			case 14:
			case 15:
				if (Pc(t, e), Ic(e), i & 4) {
					try {
						Sc(3, e, e.return), Cc(3, e);
					} catch (t) {
						$(e, e.return, t);
					}
					try {
						Sc(5, e, e.return);
					} catch (t) {
						$(e, e.return, t);
					}
				}
				break;
			case 1:
				Pc(t, e), Ic(e), i & 512 && n !== null && vc(n, n.return);
				break;
			case 5:
				if (Pc(t, e), Ic(e), i & 512 && n !== null && vc(n, n.return), e.flags & 32) {
					var a = e.stateNode;
					try {
						Le(a, "");
					} catch (t) {
						$(e, e.return, t);
					}
				}
				if (i & 4 && (a = e.stateNode, a != null)) {
					var o = e.memoizedProps, s = n === null ? o : n.memoizedProps, c = e.type, l = e.updateQueue;
					if (e.updateQueue = null, l !== null) try {
						c === "input" && o.type === "radio" && o.name != null && Ce(a, o), We(c, s);
						var u = We(c, o);
						for (s = 0; s < l.length; s += 2) {
							var d = l[s], f = l[s + 1];
							d === "style" ? Ve(a, f) : d === "dangerouslySetInnerHTML" ? Ie(a, f) : d === "children" ? Le(a, f) : ee(a, d, f, u);
						}
						switch (c) {
							case "input":
								we(a, o);
								break;
							case "textarea":
								je(a, o);
								break;
							case "select":
								var p = a._wrapperState.wasMultiple;
								a._wrapperState.wasMultiple = !!o.multiple;
								var m = o.value;
								m == null ? p !== !!o.multiple && (o.defaultValue == null ? Oe(a, !!o.multiple, o.multiple ? [] : "", !1) : Oe(a, !!o.multiple, o.defaultValue, !0)) : Oe(a, !!o.multiple, m, !1);
						}
						a[Hi] = o;
					} catch (t) {
						$(e, e.return, t);
					}
				}
				break;
			case 6:
				if (Pc(t, e), Ic(e), i & 4) {
					if (e.stateNode === null) throw Error(r(162));
					a = e.stateNode, o = e.memoizedProps;
					try {
						a.nodeValue = o;
					} catch (t) {
						$(e, e.return, t);
					}
				}
				break;
			case 3:
				if (Pc(t, e), Ic(e), i & 4 && n !== null && n.memoizedState.isDehydrated) try {
					yn(t.containerInfo);
				} catch (t) {
					$(e, e.return, t);
				}
				break;
			case 4:
				Pc(t, e), Ic(e);
				break;
			case 13:
				Pc(t, e), Ic(e), a = e.child, a.flags & 8192 && (o = a.memoizedState !== null, a.stateNode.isHidden = o, !o || a.alternate !== null && a.alternate.memoizedState !== null || (el = M())), i & 4 && Nc(e);
				break;
			case 22:
				if (d = n !== null && n.memoizedState !== null, e.mode & 1 ? (G = (u = G) || d, Pc(t, e), G = u) : Pc(t, e), Ic(e), i & 8192) {
					if (u = e.memoizedState !== null, (e.stateNode.isHidden = u) && !d && e.mode & 1) for (K = e, d = e.child; d !== null;) {
						for (f = K = d; K !== null;) {
							switch (p = K, m = p.child, p.tag) {
								case 0:
								case 11:
								case 14:
								case 15:
									Sc(4, p, p.return);
									break;
								case 1:
									vc(p, p.return);
									var h = p.stateNode;
									if (typeof h.componentWillUnmount == "function") {
										i = p, n = p.return;
										try {
											t = i, h.props = t.memoizedProps, h.state = t.memoizedState, h.componentWillUnmount();
										} catch (e) {
											$(i, n, e);
										}
									}
									break;
								case 5:
									vc(p, p.return);
									break;
								case 22: if (p.memoizedState !== null) {
									Bc(f);
									continue;
								}
							}
							m === null ? Bc(f) : (m.return = p, K = m);
						}
						d = d.sibling;
					}
					a: for (d = null, f = e;;) {
						if (f.tag === 5) {
							if (d === null) {
								d = f;
								try {
									a = f.stateNode, u ? (o = a.style, typeof o.setProperty == "function" ? o.setProperty("display", "none", "important") : o.display = "none") : (c = f.stateNode, l = f.memoizedProps.style, s = l != null && l.hasOwnProperty("display") ? l.display : null, c.style.display = Be("display", s));
								} catch (t) {
									$(e, e.return, t);
								}
							}
						} else if (f.tag === 6) {
							if (d === null) try {
								f.stateNode.nodeValue = u ? "" : f.memoizedProps;
							} catch (t) {
								$(e, e.return, t);
							}
						} else if ((f.tag !== 22 && f.tag !== 23 || f.memoizedState === null || f === e) && f.child !== null) {
							f.child.return = f, f = f.child;
							continue;
						}
						if (f === e) break a;
						for (; f.sibling === null;) {
							if (f.return === null || f.return === e) break a;
							d === f && (d = null), f = f.return;
						}
						d === f && (d = null), f.sibling.return = f.return, f = f.sibling;
					}
				}
				break;
			case 19:
				Pc(t, e), Ic(e), i & 4 && Nc(e);
				break;
			case 21: break;
			default: Pc(t, e), Ic(e);
		}
	}
	function Ic(e) {
		var t = e.flags;
		if (t & 2) {
			try {
				a: {
					for (var n = e.return; n !== null;) {
						if (Ec(n)) {
							var i = n;
							break a;
						}
						n = n.return;
					}
					throw Error(r(160));
				}
				switch (i.tag) {
					case 5:
						var a = i.stateNode;
						i.flags & 32 && (Le(a, ""), i.flags &= -33), kc(e, Dc(e), a);
						break;
					case 3:
					case 4:
						var o = i.stateNode.containerInfo;
						Oc(e, Dc(e), o);
						break;
					default: throw Error(r(161));
				}
			} catch (t) {
				$(e, e.return, t);
			}
			e.flags &= -3;
		}
		t & 4096 && (e.flags &= -4097);
	}
	function Lc(e, t, n) {
		K = e, Rc(e, t, n);
	}
	function Rc(e, t, n) {
		for (var r = (e.mode & 1) != 0; K !== null;) {
			var i = K, a = i.child;
			if (i.tag === 22 && r) {
				var o = i.memoizedState !== null || gc;
				if (!o) {
					var s = i.alternate, c = s !== null && s.memoizedState !== null || G;
					s = gc;
					var l = G;
					if (gc = o, (G = c) && !l) for (K = i; K !== null;) o = K, c = o.child, o.tag === 22 && o.memoizedState !== null || c === null ? Vc(i) : (c.return = o, K = c);
					for (; a !== null;) K = a, Rc(a, t, n), a = a.sibling;
					K = i, gc = s, G = l;
				}
				zc(e, t, n);
			} else i.subtreeFlags & 8772 && a !== null ? (a.return = i, K = a) : zc(e, t, n);
		}
	}
	function zc(e) {
		for (; K !== null;) {
			var t = K;
			if (t.flags & 8772) {
				var n = t.alternate;
				try {
					if (t.flags & 8772) switch (t.tag) {
						case 0:
						case 11:
						case 15:
							G || Cc(5, t);
							break;
						case 1:
							var i = t.stateNode;
							if (t.flags & 4 && !G) if (n === null) i.componentDidMount();
							else {
								var a = t.elementType === t.type ? n.memoizedProps : Cs(t.type, n.memoizedProps);
								i.componentDidUpdate(a, n.memoizedState, i.__reactInternalSnapshotBeforeUpdate);
							}
							var o = t.updateQueue;
							o !== null && go(t, o, i);
							break;
						case 3:
							var s = t.updateQueue;
							if (s !== null) {
								if (n = null, t.child !== null) switch (t.child.tag) {
									case 5:
										n = t.child.stateNode;
										break;
									case 1: n = t.child.stateNode;
								}
								go(t, s, n);
							}
							break;
						case 5:
							var c = t.stateNode;
							if (n === null && t.flags & 4) {
								n = c;
								var l = t.memoizedProps;
								switch (t.type) {
									case "button":
									case "input":
									case "select":
									case "textarea":
										l.autoFocus && n.focus();
										break;
									case "img": l.src && (n.src = l.src);
								}
							}
							break;
						case 6: break;
						case 4: break;
						case 12: break;
						case 13:
							if (t.memoizedState === null) {
								var u = t.alternate;
								if (u !== null) {
									var d = u.memoizedState;
									if (d !== null) {
										var f = d.dehydrated;
										f !== null && yn(f);
									}
								}
							}
							break;
						case 19:
						case 17:
						case 21:
						case 22:
						case 23:
						case 25: break;
						default: throw Error(r(163));
					}
					G || t.flags & 512 && wc(t);
				} catch (e) {
					$(t, t.return, e);
				}
			}
			if (t === e) {
				K = null;
				break;
			}
			if (n = t.sibling, n !== null) {
				n.return = t.return, K = n;
				break;
			}
			K = t.return;
		}
	}
	function Bc(e) {
		for (; K !== null;) {
			var t = K;
			if (t === e) {
				K = null;
				break;
			}
			var n = t.sibling;
			if (n !== null) {
				n.return = t.return, K = n;
				break;
			}
			K = t.return;
		}
	}
	function Vc(e) {
		for (; K !== null;) {
			var t = K;
			try {
				switch (t.tag) {
					case 0:
					case 11:
					case 15:
						var n = t.return;
						try {
							Cc(4, t);
						} catch (e) {
							$(t, n, e);
						}
						break;
					case 1:
						var r = t.stateNode;
						if (typeof r.componentDidMount == "function") {
							var i = t.return;
							try {
								r.componentDidMount();
							} catch (e) {
								$(t, i, e);
							}
						}
						var a = t.return;
						try {
							wc(t);
						} catch (e) {
							$(t, a, e);
						}
						break;
					case 5:
						var o = t.return;
						try {
							wc(t);
						} catch (e) {
							$(t, o, e);
						}
				}
			} catch (e) {
				$(t, t.return, e);
			}
			if (t === e) {
				K = null;
				break;
			}
			var s = t.sibling;
			if (s !== null) {
				s.return = t.return, K = s;
				break;
			}
			K = t.return;
		}
	}
	var Hc = Math.ceil, Uc = S.ReactCurrentDispatcher, Wc = S.ReactCurrentOwner, Gc = S.ReactCurrentBatchConfig, J = 0, Y = null, X = null, Z = 0, Kc = 0, qc = $i(0), Q = 0, Jc = null, Yc = 0, Xc = 0, Zc = 0, Qc = null, $c = null, el = 0, tl = Infinity, nl = null, rl = !1, il = null, al = null, ol = !1, sl = null, cl = 0, ll = 0, ul = null, dl = -1, fl = 0;
	function pl() {
		return J & 6 ? M() : dl === -1 ? dl = M() : dl;
	}
	function ml(e) {
		return e.mode & 1 ? J & 2 && Z !== 0 ? Z & -Z : Va.transition === null ? (e = N, e === 0 ? (e = window.event, e = e === void 0 ? 16 : Dn(e.type), e) : e) : (fl === 0 && (fl = Wt()), fl) : 1;
	}
	function hl(e, t, n, i) {
		if (50 < ll) throw ll = 0, ul = null, Error(r(185));
		Kt(e, n, i), (!(J & 2) || e !== Y) && (e === Y && (!(J & 2) && (Xc |= n), Q === 4 && xl(e, Z)), gl(e, i), n === 1 && J === 0 && !(t.mode & 1) && (tl = M() + 500, da && ha()));
	}
	function gl(e, t) {
		var n = e.callbackNode;
		Ht(e, t);
		var r = Bt(e, e === Y ? Z : 0);
		if (r === 0) n !== null && xt(n), e.callbackNode = null, e.callbackPriority = 0;
		else if (t = r & -r, e.callbackPriority !== t) {
			if (n != null && xt(n), t === 1) e.tag === 0 ? ma(Sl.bind(null, e)) : pa(Sl.bind(null, e)), Fi(function() {
				!(J & 6) && ha();
			}), n = null;
			else {
				switch (Yt(r)) {
					case 1:
						n = Tt;
						break;
					case 4:
						n = Et;
						break;
					case 16:
						n = Dt;
						break;
					case 536870912:
						n = kt;
						break;
					default: n = Dt;
				}
				n = Wl(n, _l.bind(null, e));
			}
			e.callbackPriority = t, e.callbackNode = n;
		}
	}
	function _l(e, t) {
		if (dl = -1, fl = 0, J & 6) throw Error(r(327));
		var n = e.callbackNode;
		if (Ll() && e.callbackNode !== n) return null;
		var i = Bt(e, e === Y ? Z : 0);
		if (i === 0) return null;
		if (i & 30 || (i & e.expiredLanes) !== 0 || t) t = Al(e, i);
		else {
			t = i;
			var a = J;
			J |= 2;
			var o = Ol();
			(Y !== e || Z !== t) && (nl = null, tl = M() + 500, El(e, t));
			do
				try {
					Ml();
					break;
				} catch (t) {
					Dl(e, t);
				}
			while (1);
			Qa(), Uc.current = o, J = a, X === null ? (Y = null, Z = 0, t = Q) : t = 0;
		}
		if (t !== 0) {
			if (t === 2 && (a = Ut(e), a !== 0 && (i = a, t = vl(e, a))), t === 1) throw n = Jc, El(e, 0), xl(e, i), gl(e, M()), n;
			if (t === 6) xl(e, i);
			else {
				if (a = e.current.alternate, !(i & 30) && !bl(a) && (t = Al(e, i), t === 2 && (o = Ut(e), o !== 0 && (i = o, t = vl(e, o))), t === 1)) throw n = Jc, El(e, 0), xl(e, i), gl(e, M()), n;
				switch (e.finishedWork = a, e.finishedLanes = i, t) {
					case 0:
					case 1: throw Error(r(345));
					case 2:
						Fl(e, $c, nl);
						break;
					case 3:
						if (xl(e, i), (i & 130023424) === i && (t = el + 500 - M(), 10 < t)) {
							if (Bt(e, 0) !== 0) break;
							if (a = e.suspendedLanes, (a & i) !== i) {
								pl(), e.pingedLanes |= e.suspendedLanes & a;
								break;
							}
							e.timeoutHandle = Mi(Fl.bind(null, e, $c, nl), t);
							break;
						}
						Fl(e, $c, nl);
						break;
					case 4:
						if (xl(e, i), (i & 4194240) === i) break;
						for (t = e.eventTimes, a = -1; 0 < i;) {
							var s = 31 - Nt(i);
							o = 1 << s, s = t[s], s > a && (a = s), i &= ~o;
						}
						if (i = a, i = M() - i, i = (120 > i ? 120 : 480 > i ? 480 : 1080 > i ? 1080 : 1920 > i ? 1920 : 3e3 > i ? 3e3 : 4320 > i ? 4320 : 1960 * Hc(i / 1960)) - i, 10 < i) {
							e.timeoutHandle = Mi(Fl.bind(null, e, $c, nl), i);
							break;
						}
						Fl(e, $c, nl);
						break;
					case 5:
						Fl(e, $c, nl);
						break;
					default: throw Error(r(329));
				}
			}
		}
		return gl(e, M()), e.callbackNode === n ? _l.bind(null, e) : null;
	}
	function vl(e, t) {
		var n = Qc;
		return e.current.memoizedState.isDehydrated && (El(e, t).flags |= 256), e = Al(e, t), e !== 2 && (t = $c, $c = n, t !== null && yl(t)), e;
	}
	function yl(e) {
		$c === null ? $c = e : $c.push.apply($c, e);
	}
	function bl(e) {
		for (var t = e;;) {
			if (t.flags & 16384) {
				var n = t.updateQueue;
				if (n !== null && (n = n.stores, n !== null)) for (var r = 0; r < n.length; r++) {
					var i = n[r], a = i.getSnapshot;
					i = i.value;
					try {
						if (!Lr(a(), i)) return !1;
					} catch {
						return !1;
					}
				}
			}
			if (n = t.child, t.subtreeFlags & 16384 && n !== null) n.return = t, t = n;
			else {
				if (t === e) break;
				for (; t.sibling === null;) {
					if (t.return === null || t.return === e) return !0;
					t = t.return;
				}
				t.sibling.return = t.return, t = t.sibling;
			}
		}
		return !0;
	}
	function xl(e, t) {
		for (t &= ~Zc, t &= ~Xc, e.suspendedLanes |= t, e.pingedLanes &= ~t, e = e.expirationTimes; 0 < t;) {
			var n = 31 - Nt(t), r = 1 << n;
			e[n] = -1, t &= ~r;
		}
	}
	function Sl(e) {
		if (J & 6) throw Error(r(327));
		Ll();
		var t = Bt(e, 0);
		if (!(t & 1)) return gl(e, M()), null;
		var n = Al(e, t);
		if (e.tag !== 0 && n === 2) {
			var i = Ut(e);
			i !== 0 && (t = i, n = vl(e, i));
		}
		if (n === 1) throw n = Jc, El(e, 0), xl(e, t), gl(e, M()), n;
		if (n === 6) throw Error(r(345));
		return e.finishedWork = e.current.alternate, e.finishedLanes = t, Fl(e, $c, nl), gl(e, M()), null;
	}
	function Cl(e, t) {
		var n = J;
		J |= 1;
		try {
			return e(t);
		} finally {
			J = n, J === 0 && (tl = M() + 500, da && ha());
		}
	}
	function wl(e) {
		sl !== null && sl.tag === 0 && !(J & 6) && Ll();
		var t = J;
		J |= 1;
		var n = Gc.transition, r = N;
		try {
			if (Gc.transition = null, N = 1, e) return e();
		} finally {
			N = r, Gc.transition = n, J = t, !(J & 6) && ha();
		}
	}
	function Tl() {
		Kc = qc.current, F(qc);
	}
	function El(e, t) {
		e.finishedWork = null, e.finishedLanes = 0;
		var n = e.timeoutHandle;
		if (n !== -1 && (e.timeoutHandle = -1, Ni(n)), X !== null) for (n = X.return; n !== null;) {
			var r = n;
			switch (Oa(r), r.tag) {
				case 1:
					r = r.type.childContextTypes, r != null && aa();
					break;
				case 3:
					Co(), F(ta), F(L), Oo();
					break;
				case 5:
					To(r);
					break;
				case 4:
					Co();
					break;
				case 13:
					F(z);
					break;
				case 19:
					F(z);
					break;
				case 10:
					$a(r.type._context);
					break;
				case 22:
				case 23: Tl();
			}
			n = n.return;
		}
		if (Y = e, X = e = Yl(e.current, null), Z = Kc = t, Q = 0, Jc = null, Zc = Xc = Yc = 0, $c = Qc = null, ro !== null) {
			for (t = 0; t < ro.length; t++) if (n = ro[t], r = n.interleaved, r !== null) {
				n.interleaved = null;
				var i = r.next, a = n.pending;
				if (a !== null) {
					var o = a.next;
					a.next = i, r.next = o;
				}
				n.pending = r;
			}
			ro = null;
		}
		return e;
	}
	function Dl(e, t) {
		do {
			var n = X;
			try {
				if (Qa(), ko.current = ys, Mo) {
					for (var i = B.memoizedState; i !== null;) {
						var a = i.queue;
						a !== null && (a.pending = null), i = i.next;
					}
					Mo = !1;
				}
				if (jo = 0, H = V = B = null, No = !1, Po = 0, Wc.current = null, n === null || n.return === null) {
					Q = 1, Jc = t, X = null;
					break;
				}
				a: {
					var o = e, s = n.return, c = n, l = t;
					if (t = Z, c.flags |= 32768, typeof l == "object" && l && typeof l.then == "function") {
						var u = l, d = c, f = d.tag;
						if (!(d.mode & 1) && (f === 0 || f === 11 || f === 15)) {
							var p = d.alternate;
							p ? (d.updateQueue = p.updateQueue, d.memoizedState = p.memoizedState, d.lanes = p.lanes) : (d.updateQueue = null, d.memoizedState = null);
						}
						var m = Ls(s);
						if (m !== null) {
							m.flags &= -257, Rs(m, s, c, o, t), m.mode & 1 && Is(o, u, t), t = m, l = u;
							var h = t.updateQueue;
							if (h === null) {
								var g = /* @__PURE__ */ new Set();
								g.add(l), t.updateQueue = g;
							} else h.add(l);
							break a;
						} else {
							if (!(t & 1)) {
								Is(o, u, t), kl();
								break a;
							}
							l = Error(r(426));
						}
					} else if (R && c.mode & 1) {
						var _ = Ls(s);
						if (_ !== null) {
							!(_.flags & 65536) && (_.flags |= 256), Rs(_, s, c, o, t), Ba(As(l, c));
							break a;
						}
					}
					o = l = As(l, c), Q !== 4 && (Q = 2), Qc === null ? Qc = [o] : Qc.push(o), o = s;
					do {
						switch (o.tag) {
							case 3:
								o.flags |= 65536, t &= -t, o.lanes |= t;
								var v = Ps(o, l, t);
								mo(o, v);
								break a;
							case 1:
								c = l;
								var y = o.type, b = o.stateNode;
								if (!(o.flags & 128) && (typeof y.getDerivedStateFromError == "function" || b !== null && typeof b.componentDidCatch == "function" && (al === null || !al.has(b)))) {
									o.flags |= 65536, t &= -t, o.lanes |= t;
									var x = Fs(o, c, t);
									mo(o, x);
									break a;
								}
						}
						o = o.return;
					} while (o !== null);
				}
				Pl(n);
			} catch (e) {
				t = e, X === n && n !== null && (X = n = n.return);
				continue;
			}
			break;
		} while (1);
	}
	function Ol() {
		var e = Uc.current;
		return Uc.current = ys, e === null ? ys : e;
	}
	function kl() {
		(Q === 0 || Q === 3 || Q === 2) && (Q = 4), Y === null || !(Yc & 268435455) && !(Xc & 268435455) || xl(Y, Z);
	}
	function Al(e, t) {
		var n = J;
		J |= 2;
		var i = Ol();
		(Y !== e || Z !== t) && (nl = null, El(e, t));
		do
			try {
				jl();
				break;
			} catch (t) {
				Dl(e, t);
			}
		while (1);
		if (Qa(), J = n, Uc.current = i, X !== null) throw Error(r(261));
		return Y = null, Z = 0, Q;
	}
	function jl() {
		for (; X !== null;) Nl(X);
	}
	function Ml() {
		for (; X !== null && !St();) Nl(X);
	}
	function Nl(e) {
		var t = Ul(e.alternate, e, Kc);
		e.memoizedProps = e.pendingProps, t === null ? Pl(e) : X = t, Wc.current = null;
	}
	function Pl(e) {
		var t = e;
		do {
			var n = t.alternate;
			if (e = t.return, t.flags & 32768) {
				if (n = hc(n, t), n !== null) {
					n.flags &= 32767, X = n;
					return;
				}
				if (e !== null) e.flags |= 32768, e.subtreeFlags = 0, e.deletions = null;
				else {
					Q = 6, X = null;
					return;
				}
			} else if (n = mc(n, t, Kc), n !== null) {
				X = n;
				return;
			}
			if (t = t.sibling, t !== null) {
				X = t;
				return;
			}
			X = t = e;
		} while (t !== null);
		Q === 0 && (Q = 5);
	}
	function Fl(e, t, n) {
		var r = N, i = Gc.transition;
		try {
			Gc.transition = null, N = 1, Il(e, t, n, r);
		} finally {
			Gc.transition = i, N = r;
		}
		return null;
	}
	function Il(e, t, n, i) {
		do
			Ll();
		while (sl !== null);
		if (J & 6) throw Error(r(327));
		n = e.finishedWork;
		var a = e.finishedLanes;
		if (n === null) return null;
		if (e.finishedWork = null, e.finishedLanes = 0, n === e.current) throw Error(r(177));
		e.callbackNode = null, e.callbackPriority = 0;
		var o = n.lanes | n.childLanes;
		if (qt(e, o), e === Y && (X = Y = null, Z = 0), !(n.subtreeFlags & 2064) && !(n.flags & 2064) || ol || (ol = !0, Wl(Dt, function() {
			return Ll(), null;
		})), o = (n.flags & 15990) != 0, n.subtreeFlags & 15990 || o) {
			o = Gc.transition, Gc.transition = null;
			var s = N;
			N = 1;
			var c = J;
			J |= 4, Wc.current = null, xc(e, n), Fc(n, e), Wr(Ai), xn = !!ki, Ai = ki = null, e.current = n, Lc(n, e, a), Ct(), J = c, N = s, Gc.transition = o;
		} else e.current = n;
		if (ol && (ol = !1, sl = e, cl = a), o = e.pendingLanes, o === 0 && (al = null), Mt(n.stateNode, i), gl(e, M()), t !== null) for (i = e.onRecoverableError, n = 0; n < t.length; n++) a = t[n], i(a.value, {
			componentStack: a.stack,
			digest: a.digest
		});
		if (rl) throw rl = !1, e = il, il = null, e;
		return cl & 1 && e.tag !== 0 && Ll(), o = e.pendingLanes, o & 1 ? e === ul ? ll++ : (ll = 0, ul = e) : ll = 0, ha(), null;
	}
	function Ll() {
		if (sl !== null) {
			var e = Yt(cl), t = Gc.transition, n = N;
			try {
				if (Gc.transition = null, N = 16 > e ? 16 : e, sl === null) var i = !1;
				else {
					if (e = sl, sl = null, cl = 0, J & 6) throw Error(r(331));
					var a = J;
					for (J |= 4, K = e.current; K !== null;) {
						var o = K, s = o.child;
						if (K.flags & 16) {
							var c = o.deletions;
							if (c !== null) {
								for (var l = 0; l < c.length; l++) {
									var u = c[l];
									for (K = u; K !== null;) {
										var d = K;
										switch (d.tag) {
											case 0:
											case 11:
											case 15: Sc(8, d, o);
										}
										var f = d.child;
										if (f !== null) f.return = d, K = f;
										else for (; K !== null;) {
											d = K;
											var p = d.sibling, m = d.return;
											if (Tc(d), d === u) {
												K = null;
												break;
											}
											if (p !== null) {
												p.return = m, K = p;
												break;
											}
											K = m;
										}
									}
								}
								var h = o.alternate;
								if (h !== null) {
									var g = h.child;
									if (g !== null) {
										h.child = null;
										do {
											var _ = g.sibling;
											g.sibling = null, g = _;
										} while (g !== null);
									}
								}
								K = o;
							}
						}
						if (o.subtreeFlags & 2064 && s !== null) s.return = o, K = s;
						else b: for (; K !== null;) {
							if (o = K, o.flags & 2048) switch (o.tag) {
								case 0:
								case 11:
								case 15: Sc(9, o, o.return);
							}
							var v = o.sibling;
							if (v !== null) {
								v.return = o.return, K = v;
								break b;
							}
							K = o.return;
						}
					}
					var y = e.current;
					for (K = y; K !== null;) {
						s = K;
						var b = s.child;
						if (s.subtreeFlags & 2064 && b !== null) b.return = s, K = b;
						else b: for (s = y; K !== null;) {
							if (c = K, c.flags & 2048) try {
								switch (c.tag) {
									case 0:
									case 11:
									case 15: Cc(9, c);
								}
							} catch (e) {
								$(c, c.return, e);
							}
							if (c === s) {
								K = null;
								break b;
							}
							var x = c.sibling;
							if (x !== null) {
								x.return = c.return, K = x;
								break b;
							}
							K = c.return;
						}
					}
					if (J = a, ha(), jt && typeof jt.onPostCommitFiberRoot == "function") try {
						jt.onPostCommitFiberRoot(At, e);
					} catch {}
					i = !0;
				}
				return i;
			} finally {
				N = n, Gc.transition = t;
			}
		}
		return !1;
	}
	function Rl(e, t, n) {
		t = As(n, t), t = Ps(e, t, 1), e = fo(e, t, 1), t = pl(), e !== null && (Kt(e, 1, t), gl(e, t));
	}
	function $(e, t, n) {
		if (e.tag === 3) Rl(e, e, n);
		else for (; t !== null;) {
			if (t.tag === 3) {
				Rl(t, e, n);
				break;
			} else if (t.tag === 1) {
				var r = t.stateNode;
				if (typeof t.type.getDerivedStateFromError == "function" || typeof r.componentDidCatch == "function" && (al === null || !al.has(r))) {
					e = As(n, e), e = Fs(t, e, 1), t = fo(t, e, 1), e = pl(), t !== null && (Kt(t, 1, e), gl(t, e));
					break;
				}
			}
			t = t.return;
		}
	}
	function zl(e, t, n) {
		var r = e.pingCache;
		r !== null && r.delete(t), t = pl(), e.pingedLanes |= e.suspendedLanes & n, Y === e && (Z & n) === n && (Q === 4 || Q === 3 && (Z & 130023424) === Z && 500 > M() - el ? El(e, 0) : Zc |= n), gl(e, t);
	}
	function Bl(e, t) {
		t === 0 && (e.mode & 1 ? (t = Rt, Rt <<= 1, !(Rt & 130023424) && (Rt = 4194304)) : t = 1);
		var n = pl();
		e = oo(e, t), e !== null && (Kt(e, t, n), gl(e, n));
	}
	function Vl(e) {
		var t = e.memoizedState, n = 0;
		t !== null && (n = t.retryLane), Bl(e, n);
	}
	function Hl(e, t) {
		var n = 0;
		switch (e.tag) {
			case 13:
				var i = e.stateNode, a = e.memoizedState;
				a !== null && (n = a.retryLane);
				break;
			case 19:
				i = e.stateNode;
				break;
			default: throw Error(r(314));
		}
		i !== null && i.delete(t), Bl(e, n);
	}
	var Ul = function(e, t, n) {
		if (e !== null) if (e.memoizedProps !== t.pendingProps || ta.current) Bs = !0;
		else {
			if ((e.lanes & n) === 0 && !(t.flags & 128)) return Bs = !1, lc(e, t, n);
			Bs = !!(e.flags & 131072);
		}
		else Bs = !1, R && t.flags & 1048576 && Ea(t, ya, t.index);
		switch (t.lanes = 0, t.tag) {
			case 2:
				var i = t.type;
				sc(e, t), e = t.pendingProps;
				var a = ra(t, L.current);
				to(t, n), a = Lo(null, t, i, e, a, n);
				var o = Ro();
				return t.flags |= 1, typeof a == "object" && a && typeof a.render == "function" && a.$$typeof === void 0 ? (t.tag = 1, t.memoizedState = null, t.updateQueue = null, ia(i) ? (o = !0, ca(t)) : o = !1, t.memoizedState = a.state !== null && a.state !== void 0 ? a.state : null, co(t), a.updater = Ts, t.stateNode = a, a._reactInternals = t, ks(t, i, e, n), t = Ys(null, t, i, !0, o, n)) : (t.tag = 0, R && o && Da(t), Vs(null, t, a, n), t = t.child), t;
			case 16:
				i = t.elementType;
				a: {
					switch (sc(e, t), e = t.pendingProps, a = i._init, i = a(i._payload), t.type = i, a = t.tag = Jl(i), e = Cs(i, e), a) {
						case 0:
							t = qs(null, t, i, e, n);
							break a;
						case 1:
							t = Js(null, t, i, e, n);
							break a;
						case 11:
							t = Hs(null, t, i, e, n);
							break a;
						case 14:
							t = Us(null, t, i, Cs(i.type, e), n);
							break a;
					}
					throw Error(r(306, i, ""));
				}
				return t;
			case 0: return i = t.type, a = t.pendingProps, a = t.elementType === i ? a : Cs(i, a), qs(e, t, i, a, n);
			case 1: return i = t.type, a = t.pendingProps, a = t.elementType === i ? a : Cs(i, a), Js(e, t, i, a, n);
			case 3:
				a: {
					if (Xs(t), e === null) throw Error(r(387));
					i = t.pendingProps, o = t.memoizedState, a = o.element, lo(e, t), ho(t, i, null, n);
					var s = t.memoizedState;
					if (i = s.element, o.isDehydrated) if (o = {
						element: i,
						isDehydrated: !1,
						cache: s.cache,
						pendingSuspenseBoundaries: s.pendingSuspenseBoundaries,
						transitions: s.transitions
					}, t.updateQueue.baseState = o, t.memoizedState = o, t.flags & 256) {
						a = As(Error(r(423)), t), t = Zs(e, t, i, n, a);
						break a;
					} else if (i !== a) {
						a = As(Error(r(424)), t), t = Zs(e, t, i, n, a);
						break a;
					} else for (Aa = Ri(t.stateNode.containerInfo.firstChild), ka = t, R = !0, ja = null, n = qa(t, null, i, n), t.child = n; n;) n.flags = n.flags & -3 | 4096, n = n.sibling;
					else {
						if (za(), i === a) {
							t = cc(e, t, n);
							break a;
						}
						Vs(e, t, i, n);
					}
					t = t.child;
				}
				return t;
			case 5: return wo(t), e === null && Fa(t), i = t.type, a = t.pendingProps, o = e === null ? null : e.memoizedProps, s = a.children, ji(i, a) ? s = null : o !== null && ji(i, o) && (t.flags |= 32), Ks(e, t), Vs(e, t, s, n), t.child;
			case 6: return e === null && Fa(t), null;
			case 13: return ec(e, t, n);
			case 4: return So(t, t.stateNode.containerInfo), i = t.pendingProps, e === null ? t.child = Ka(t, null, i, n) : Vs(e, t, i, n), t.child;
			case 11: return i = t.type, a = t.pendingProps, a = t.elementType === i ? a : Cs(i, a), Hs(e, t, i, a, n);
			case 7: return Vs(e, t, t.pendingProps, n), t.child;
			case 8: return Vs(e, t, t.pendingProps.children, n), t.child;
			case 12: return Vs(e, t, t.pendingProps.children, n), t.child;
			case 10:
				a: {
					if (i = t.type._context, a = t.pendingProps, o = t.memoizedProps, s = a.value, I(Ja, i._currentValue), i._currentValue = s, o !== null) if (Lr(o.value, s)) {
						if (o.children === a.children && !ta.current) {
							t = cc(e, t, n);
							break a;
						}
					} else for (o = t.child, o !== null && (o.return = t); o !== null;) {
						var c = o.dependencies;
						if (c !== null) {
							s = o.child;
							for (var l = c.firstContext; l !== null;) {
								if (l.context === i) {
									if (o.tag === 1) {
										l = uo(-1, n & -n), l.tag = 2;
										var u = o.updateQueue;
										if (u !== null) {
											u = u.shared;
											var d = u.pending;
											d === null ? l.next = l : (l.next = d.next, d.next = l), u.pending = l;
										}
									}
									o.lanes |= n, l = o.alternate, l !== null && (l.lanes |= n), eo(o.return, n, t), c.lanes |= n;
									break;
								}
								l = l.next;
							}
						} else if (o.tag === 10) s = o.type === t.type ? null : o.child;
						else if (o.tag === 18) {
							if (s = o.return, s === null) throw Error(r(341));
							s.lanes |= n, c = s.alternate, c !== null && (c.lanes |= n), eo(s, n, t), s = o.sibling;
						} else s = o.child;
						if (s !== null) s.return = o;
						else for (s = o; s !== null;) {
							if (s === t) {
								s = null;
								break;
							}
							if (o = s.sibling, o !== null) {
								o.return = s.return, s = o;
								break;
							}
							s = s.return;
						}
						o = s;
					}
					Vs(e, t, a.children, n), t = t.child;
				}
				return t;
			case 9: return a = t.type, i = t.pendingProps.children, to(t, n), a = no(a), i = i(a), t.flags |= 1, Vs(e, t, i, n), t.child;
			case 14: return i = t.type, a = Cs(i, t.pendingProps), a = Cs(i.type, a), Us(e, t, i, a, n);
			case 15: return Ws(e, t, t.type, t.pendingProps, n);
			case 17: return i = t.type, a = t.pendingProps, a = t.elementType === i ? a : Cs(i, a), sc(e, t), t.tag = 1, ia(i) ? (e = !0, ca(t)) : e = !1, to(t, n), Ds(t, i, a), ks(t, i, a, n), Ys(null, t, i, !0, e, n);
			case 19: return oc(e, t, n);
			case 22: return Gs(e, t, n);
		}
		throw Error(r(156, t.tag));
	};
	function Wl(e, t) {
		return bt(e, t);
	}
	function Gl(e, t, n, r) {
		this.tag = e, this.key = n, this.sibling = this.child = this.return = this.stateNode = this.type = this.elementType = null, this.index = 0, this.ref = null, this.pendingProps = t, this.dependencies = this.memoizedState = this.updateQueue = this.memoizedProps = null, this.mode = r, this.subtreeFlags = this.flags = 0, this.deletions = null, this.childLanes = this.lanes = 0, this.alternate = null;
	}
	function Kl(e, t, n, r) {
		return new Gl(e, t, n, r);
	}
	function ql(e) {
		return e = e.prototype, !(!e || !e.isReactComponent);
	}
	function Jl(e) {
		if (typeof e == "function") return +!!ql(e);
		if (e != null) {
			if (e = e.$$typeof, e === ae) return 11;
			if (e === E) return 14;
		}
		return 2;
	}
	function Yl(e, t) {
		var n = e.alternate;
		return n === null ? (n = Kl(e.tag, t, e.key, e.mode), n.elementType = e.elementType, n.type = e.type, n.stateNode = e.stateNode, n.alternate = e, e.alternate = n) : (n.pendingProps = t, n.type = e.type, n.flags = 0, n.subtreeFlags = 0, n.deletions = null), n.flags = e.flags & 14680064, n.childLanes = e.childLanes, n.lanes = e.lanes, n.child = e.child, n.memoizedProps = e.memoizedProps, n.memoizedState = e.memoizedState, n.updateQueue = e.updateQueue, t = e.dependencies, n.dependencies = t === null ? null : {
			lanes: t.lanes,
			firstContext: t.firstContext
		}, n.sibling = e.sibling, n.index = e.index, n.ref = e.ref, n;
	}
	function Xl(e, t, n, i, a, o) {
		var s = 2;
		if (i = e, typeof e == "function") ql(e) && (s = 1);
		else if (typeof e == "string") s = 5;
		else a: switch (e) {
			case ne: return Zl(n.children, a, o, t);
			case re:
				s = 8, a |= 8;
				break;
			case w: return e = Kl(12, n, t, a | 2), e.elementType = w, e.lanes = o, e;
			case oe: return e = Kl(13, n, t, a), e.elementType = oe, e.lanes = o, e;
			case se: return e = Kl(19, n, t, a), e.elementType = se, e.lanes = o, e;
			case ce: return Ql(n, a, o, t);
			default:
				if (typeof e == "object" && e) switch (e.$$typeof) {
					case T:
						s = 10;
						break a;
					case ie:
						s = 9;
						break a;
					case ae:
						s = 11;
						break a;
					case E:
						s = 14;
						break a;
					case D:
						s = 16, i = null;
						break a;
				}
				throw Error(r(130, e == null ? e : typeof e, ""));
		}
		return t = Kl(s, n, t, a), t.elementType = e, t.type = i, t.lanes = o, t;
	}
	function Zl(e, t, n, r) {
		return e = Kl(7, e, r, t), e.lanes = n, e;
	}
	function Ql(e, t, n, r) {
		return e = Kl(22, e, r, t), e.elementType = ce, e.lanes = n, e.stateNode = { isHidden: !1 }, e;
	}
	function $l(e, t, n) {
		return e = Kl(6, e, null, t), e.lanes = n, e;
	}
	function eu(e, t, n) {
		return t = Kl(4, e.children === null ? [] : e.children, e.key, t), t.lanes = n, t.stateNode = {
			containerInfo: e.containerInfo,
			pendingChildren: null,
			implementation: e.implementation
		}, t;
	}
	function tu(e, t, n, r, i) {
		this.tag = t, this.containerInfo = e, this.finishedWork = this.pingCache = this.current = this.pendingChildren = null, this.timeoutHandle = -1, this.callbackNode = this.pendingContext = this.context = null, this.callbackPriority = 0, this.eventTimes = Gt(0), this.expirationTimes = Gt(-1), this.entangledLanes = this.finishedLanes = this.mutableReadLanes = this.expiredLanes = this.pingedLanes = this.suspendedLanes = this.pendingLanes = 0, this.entanglements = Gt(0), this.identifierPrefix = r, this.onRecoverableError = i, this.mutableSourceEagerHydrationData = null;
	}
	function nu(e, t, n, r, i, a, o, s, c) {
		return e = new tu(e, t, n, s, c), t === 1 ? (t = 1, !0 === a && (t |= 8)) : t = 0, a = Kl(3, null, null, t), e.current = a, a.stateNode = e, a.memoizedState = {
			element: r,
			isDehydrated: n,
			cache: null,
			transitions: null,
			pendingSuspenseBoundaries: null
		}, co(a), e;
	}
	function ru(e, t, n) {
		var r = 3 < arguments.length && arguments[3] !== void 0 ? arguments[3] : null;
		return {
			$$typeof: C,
			key: r == null ? null : "" + r,
			children: e,
			containerInfo: t,
			implementation: n
		};
	}
	function iu(e) {
		if (!e) return ea;
		e = e._reactInternals;
		a: {
			if (mt(e) !== e || e.tag !== 1) throw Error(r(170));
			var t = e;
			do {
				switch (t.tag) {
					case 3:
						t = t.stateNode.context;
						break a;
					case 1: if (ia(t.type)) {
						t = t.stateNode.__reactInternalMemoizedMergedChildContext;
						break a;
					}
				}
				t = t.return;
			} while (t !== null);
			throw Error(r(171));
		}
		if (e.tag === 1) {
			var n = e.type;
			if (ia(n)) return sa(e, n, t);
		}
		return t;
	}
	function au(e, t, n, r, i, a, o, s, c) {
		return e = nu(n, r, !0, e, i, a, o, s, c), e.context = iu(null), n = e.current, r = pl(), i = ml(n), a = uo(r, i), a.callback = t ?? null, fo(n, a, i), e.current.lanes = i, Kt(e, i, r), gl(e, r), e;
	}
	function ou(e, t, n, r) {
		var i = t.current, a = pl(), o = ml(i);
		return n = iu(n), t.context === null ? t.context = n : t.pendingContext = n, t = uo(a, o), t.payload = { element: e }, r = r === void 0 ? null : r, r !== null && (t.callback = r), e = fo(i, t, o), e !== null && (hl(e, i, o, a), po(e, i, o)), o;
	}
	function su(e) {
		if (e = e.current, !e.child) return null;
		switch (e.child.tag) {
			case 5: return e.child.stateNode;
			default: return e.child.stateNode;
		}
	}
	function cu(e, t) {
		if (e = e.memoizedState, e !== null && e.dehydrated !== null) {
			var n = e.retryLane;
			e.retryLane = n !== 0 && n < t ? n : t;
		}
	}
	function lu(e, t) {
		cu(e, t), (e = e.alternate) && cu(e, t);
	}
	function uu() {
		return null;
	}
	var du = typeof reportError == "function" ? reportError : function(e) {
		console.error(e);
	};
	function fu(e) {
		this._internalRoot = e;
	}
	pu.prototype.render = fu.prototype.render = function(e) {
		var t = this._internalRoot;
		if (t === null) throw Error(r(409));
		ou(e, t, null, null);
	}, pu.prototype.unmount = fu.prototype.unmount = function() {
		var e = this._internalRoot;
		if (e !== null) {
			this._internalRoot = null;
			var t = e.containerInfo;
			wl(function() {
				ou(null, e, null, null);
			}), t[Ui] = null;
		}
	};
	function pu(e) {
		this._internalRoot = e;
	}
	pu.prototype.unstable_scheduleHydration = function(e) {
		if (e) {
			var t = $t();
			e = {
				blockedOn: null,
				target: e,
				priority: t
			};
			for (var n = 0; n < ln.length && t !== 0 && t < ln[n].priority; n++);
			ln.splice(n, 0, e), n === 0 && mn(e);
		}
	};
	function mu(e) {
		return !(!e || e.nodeType !== 1 && e.nodeType !== 9 && e.nodeType !== 11);
	}
	function hu(e) {
		return !(!e || e.nodeType !== 1 && e.nodeType !== 9 && e.nodeType !== 11 && (e.nodeType !== 8 || e.nodeValue !== " react-mount-point-unstable "));
	}
	function gu() {}
	function _u(e, t, n, r, i) {
		if (i) {
			if (typeof r == "function") {
				var a = r;
				r = function() {
					var e = su(o);
					a.call(e);
				};
			}
			var o = au(t, r, e, 0, null, !1, !1, "", gu);
			return e._reactRootContainer = o, e[Ui] = o.current, _i(e.nodeType === 8 ? e.parentNode : e), wl(), o;
		}
		for (; i = e.lastChild;) e.removeChild(i);
		if (typeof r == "function") {
			var s = r;
			r = function() {
				var e = su(c);
				s.call(e);
			};
		}
		var c = nu(e, 0, !1, null, null, !1, !1, "", gu);
		return e._reactRootContainer = c, e[Ui] = c.current, _i(e.nodeType === 8 ? e.parentNode : e), wl(function() {
			ou(t, c, n, r);
		}), c;
	}
	function vu(e, t, n, r, i) {
		var a = n._reactRootContainer;
		if (a) {
			var o = a;
			if (typeof i == "function") {
				var s = i;
				i = function() {
					var e = su(o);
					s.call(e);
				};
			}
			ou(t, o, e, i);
		} else o = _u(n, t, e, i, r);
		return su(o);
	}
	Xt = function(e) {
		switch (e.tag) {
			case 3:
				var t = e.stateNode;
				if (t.current.memoizedState.isDehydrated) {
					var n = zt(t.pendingLanes);
					n !== 0 && (Jt(t, n | 1), gl(t, M()), !(J & 6) && (tl = M() + 500, ha()));
				}
				break;
			case 13: wl(function() {
				var t = oo(e, 1);
				t !== null && hl(t, e, 1, pl());
			}), lu(e, 1);
		}
	}, Zt = function(e) {
		if (e.tag === 13) {
			var t = oo(e, 134217728);
			t !== null && hl(t, e, 134217728, pl()), lu(e, 134217728);
		}
	}, Qt = function(e) {
		if (e.tag === 13) {
			var t = ml(e), n = oo(e, t);
			n !== null && hl(n, e, t, pl()), lu(e, t);
		}
	}, $t = function() {
		return N;
	}, en = function(e, t) {
		var n = N;
		try {
			return N = e, t();
		} finally {
			N = n;
		}
	}, qe = function(e, t, n) {
		switch (t) {
			case "input":
				if (we(e, n), t = n.name, n.type === "radio" && t != null) {
					for (n = e; n.parentNode;) n = n.parentNode;
					for (n = n.querySelectorAll("input[name=" + JSON.stringify("" + t) + "][type=\"radio\"]"), t = 0; t < n.length; t++) {
						var i = n[t];
						if (i !== e && i.form === e.form) {
							var a = Xi(i);
							if (!a) throw Error(r(90));
							j(i), we(i, a);
						}
					}
				}
				break;
			case "textarea":
				je(e, n);
				break;
			case "select": t = n.value, t != null && Oe(e, !!n.multiple, t, !1);
		}
	}, $e = Cl, et = wl;
	var yu = {
		usingClientEntryPoint: !1,
		Events: [
			Ji,
			Yi,
			Xi,
			Ze,
			Qe,
			Cl
		]
	}, bu = {
		findFiberByHostInstance: qi,
		bundleType: 0,
		version: "18.3.1",
		rendererPackageName: "react-dom"
	}, xu = {
		bundleType: bu.bundleType,
		version: bu.version,
		rendererPackageName: bu.rendererPackageName,
		rendererConfig: bu.rendererConfig,
		overrideHookState: null,
		overrideHookStateDeletePath: null,
		overrideHookStateRenamePath: null,
		overrideProps: null,
		overridePropsDeletePath: null,
		overridePropsRenamePath: null,
		setErrorHandler: null,
		setSuspenseHandler: null,
		scheduleUpdate: null,
		currentDispatcherRef: S.ReactCurrentDispatcher,
		findHostInstanceByFiber: function(e) {
			return e = vt(e), e === null ? null : e.stateNode;
		},
		findFiberByHostInstance: bu.findFiberByHostInstance || uu,
		findHostInstancesForRefresh: null,
		scheduleRefresh: null,
		scheduleRoot: null,
		setRefreshHandler: null,
		getCurrentFiber: null,
		reconcilerVersion: "18.3.1-next-f1338f8080-20240426"
	};
	if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < "u") {
		var Su = __REACT_DEVTOOLS_GLOBAL_HOOK__;
		if (!Su.isDisabled && Su.supportsFiber) try {
			At = Su.inject(xu), jt = Su;
		} catch {}
	}
	e.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED = yu, e.createPortal = function(e, t) {
		var n = 2 < arguments.length && arguments[2] !== void 0 ? arguments[2] : null;
		if (!mu(t)) throw Error(r(200));
		return ru(e, t, null, n);
	}, e.createRoot = function(e, t) {
		if (!mu(e)) throw Error(r(299));
		var n = !1, i = "", a = du;
		return t != null && (!0 === t.unstable_strictMode && (n = !0), t.identifierPrefix !== void 0 && (i = t.identifierPrefix), t.onRecoverableError !== void 0 && (a = t.onRecoverableError)), t = nu(e, 1, !1, null, null, n, !1, i, a), e[Ui] = t.current, _i(e.nodeType === 8 ? e.parentNode : e), new fu(t);
	}, e.findDOMNode = function(e) {
		if (e == null) return null;
		if (e.nodeType === 1) return e;
		var t = e._reactInternals;
		if (t === void 0) throw typeof e.render == "function" ? Error(r(188)) : (e = Object.keys(e).join(","), Error(r(268, e)));
		return e = vt(t), e = e === null ? null : e.stateNode, e;
	}, e.flushSync = function(e) {
		return wl(e);
	}, e.hydrate = function(e, t, n) {
		if (!hu(t)) throw Error(r(200));
		return vu(null, e, t, !0, n);
	}, e.hydrateRoot = function(e, t, n) {
		if (!mu(e)) throw Error(r(405));
		var i = n != null && n.hydratedSources || null, a = !1, o = "", s = du;
		if (n != null && (!0 === n.unstable_strictMode && (a = !0), n.identifierPrefix !== void 0 && (o = n.identifierPrefix), n.onRecoverableError !== void 0 && (s = n.onRecoverableError)), t = au(t, null, e, 1, n ?? null, a, !1, o, s), e[Ui] = t.current, _i(e), i) for (e = 0; e < i.length; e++) n = i[e], a = n._getVersion, a = a(n._source), t.mutableSourceEagerHydrationData == null ? t.mutableSourceEagerHydrationData = [n, a] : t.mutableSourceEagerHydrationData.push(n, a);
		return new pu(t);
	}, e.render = function(e, t, n) {
		if (!hu(t)) throw Error(r(200));
		return vu(null, e, t, !1, n);
	}, e.unmountComponentAtNode = function(e) {
		if (!hu(e)) throw Error(r(40));
		return e._reactRootContainer ? (wl(function() {
			vu(null, null, e, !1, function() {
				e._reactRootContainer = null, e[Ui] = null;
			});
		}), !0) : !1;
	}, e.unstable_batchedUpdates = Cl, e.unstable_renderSubtreeIntoContainer = function(e, t, n, i) {
		if (!hu(n)) throw Error(r(200));
		if (e == null || e._reactInternals === void 0) throw Error(r(38));
		return vu(e, t, n, !1, i);
	}, e.version = "18.3.1-next-f1338f8080-20240426";
})), m = /* @__PURE__ */ o(((e, t) => {
	function n() {
		if (!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function")) try {
			__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(n);
		} catch (e) {
			console.error(e);
		}
	}
	n(), t.exports = p();
})), h = /* @__PURE__ */ o(((e) => {
	var t = m();
	e.createRoot = t.createRoot, e.hydrateRoot = t.hydrateRoot;
})), g = /* @__PURE__ */ c(u(), 1), _ = h(), v = class extends Error {
	constructor(e, { status: t = 0, code: n = "engine-request-failed", url: r = "" } = {}) {
		super(e), this.name = "EngineRequestError", this.status = t, this.code = n, this.url = r;
	}
};
function y(e) {
	if (typeof e != "string") throw TypeError("engine base must be a string");
	let t = e.replace(/\/+$/, "");
	return t === "/" ? "" : t;
}
function b({ base: e = "/opentake-studio-route-b", fetchImpl: t = globalThis.fetch, signal: n } = {}) {
	if (typeof t != "function") throw TypeError("fetchImpl must be a function");
	let r = y(e);
	async function i(e, { method: i = "GET", body: a, signal: o } = {}) {
		let s = `${r}${e}`, c = { accept: "application/json" }, l = {
			method: i,
			headers: c,
			signal: o ?? n
		};
		a !== void 0 && (c["content-type"] = "application/json", l.body = JSON.stringify(a));
		let u;
		try {
			u = await t(s, l);
		} catch (e) {
			throw e?.name === "AbortError" ? e : new v(`engine request failed: ${e instanceof Error ? e.message : String(e)}`, {
				code: "engine-network-error",
				url: s
			});
		}
		let d = typeof u.text == "function" ? await u.text() : "", f = null;
		if (d.length > 0) try {
			f = JSON.parse(d);
		} catch {
			throw new v("engine returned invalid JSON", {
				status: u.status ?? 0,
				code: "engine-invalid-json",
				url: s
			});
		}
		if (!u.ok) {
			let e = f?.error ?? {};
			throw new v(typeof e.message == "string" && e.message.length > 0 ? e.message : `engine request failed with HTTP ${u.status}`, {
				status: u.status ?? 0,
				code: typeof e.code == "string" && e.code.length > 0 ? e.code : "engine-http-error",
				url: s
			});
		}
		return f;
	}
	return {
		base: r,
		request: i,
		info: () => i("/engine/info"),
		timeline: () => i("/engine/timeline"),
		media: () => i("/engine/media"),
		newProject: () => i("/engine/new", { method: "POST" }),
		openProject: (e) => {
			if (typeof e != "string" || e.trim().length === 0) throw TypeError("openProject requires a non-empty path");
			return i("/engine/open", {
				method: "POST",
				body: { path: e }
			});
		},
		saveProject: (e = null) => i("/engine/save", {
			method: "POST",
			body: e == null ? {} : { path: e }
		}),
		apply: (e) => {
			if (typeof e != "object" || !e || Array.isArray(e)) throw TypeError("apply requires an edit command object");
			return i("/engine/apply", {
				method: "POST",
				body: { command: e }
			});
		},
		invoke: (e, t = {}) => {
			if (typeof e != "string" || e.length === 0) throw TypeError("invoke requires a command name");
			if (typeof t != "object" || !t || Array.isArray(t)) throw TypeError("invoke args must be an object");
			return i("/engine/invoke", {
				method: "POST",
				body: {
					cmd: e,
					args: t
				}
			});
		},
		exportStatus: () => i("/engine/export/status"),
		playbackStatus: () => i("/engine/playback/status"),
		importMedia: (e) => {
			if (!Array.isArray(e) || e.some((e) => typeof e != "string")) throw TypeError("importMedia requires an array of paths");
			return i("/engine/import-media", {
				method: "POST",
				body: { paths: e }
			});
		},
		undo: () => i("/engine/undo", { method: "POST" }),
		redo: () => i("/engine/redo", { method: "POST" }),
		previewUrl: (e, { revision: t = 0, format: n = "png" } = {}) => {
			let i = Number.isFinite(Number(e)) ? Math.max(0, Math.trunc(Number(e))) : 0;
			return `${r}/engine/preview/frame?frame=${i}&format=${n}&rev=${Math.trunc(Number(t) || 0)}`;
		},
		assetUrl: (e) => typeof e != "string" || e.length === 0 ? null : `${r}/engine/asset?path=${encodeURIComponent(e)}`
	};
}
//#endregion
//#region web/src/native/locale.js
var x = Object.freeze({
	en: Object.freeze({
		appName: "OpenTake",
		nativePreview: "Native editor prototype",
		home: "Home",
		editor: "Editor",
		media: "Media",
		timeline: "Timeline",
		preview: "Preview",
		engine: "Engine",
		project: "Project",
		noProject: "No project opened",
		newProject: "New project",
		openProject: "Open project",
		saveProject: "Save project",
		saveAs: "Save as",
		projectPath: "Project path",
		recentUnavailable: "Recent projects are not exposed by a Host route yet.",
		loading: "Loading…",
		retry: "Retry",
		dismiss: "Dismiss",
		noMedia: "No media imported.",
		noTracks: "No tracks yet.",
		selectClip: "Select a clip",
		selected: "Selected",
		frame: "Frame",
		previousFrame: "Previous frame",
		nextFrame: "Next frame",
		moveLeft: "Move left",
		moveRight: "Move right",
		undo: "Undo",
		redo: "Redo",
		refresh: "Refresh",
		unavailable: "Engine unavailable",
		tracks: "tracks",
		clips: "clips",
		duration: "Duration",
		status: "Status",
		locale: "Language",
		theme: "Theme",
		light: "Light",
		dark: "Dark",
		system: "System",
		clip: "Clip",
		track: "Track",
		start: "Start",
		engineReady: "Connected",
		engineDown: "Not connected",
		importMedia: "Import media",
		mediaCount: "{count} items",
		projectVersion: "Version {version}",
		busy: "Working…",
		allChanges: "All changes are engine-backed.",
		prototypeNotice: "Bounded native mount: home, media, timeline and preview. The full editor remains in the iframe fallback.",
		advanced: "Advanced",
		colorGrade: "Color grade",
		exposure: "Exposure",
		temperature: "Temperature",
		contrast: "Contrast",
		saturation: "Saturation",
		textStyle: "Text style",
		fontName: "Font",
		fontSize: "Size",
		textColor: "Color",
		chromaKey: "Chroma key",
		keyColor: "Key color",
		similarity: "Similarity",
		spill: "Spill",
		lut: "LUT",
		lutId: "LUT id (64 hex)",
		lutName: "LUT name",
		lutIntensity: "LUT intensity",
		noLut: "No LUT applied.",
		lutInvalid: "LUT id must be 64 hex characters and name must be non-empty.",
		remove: "Remove",
		maskTransform: "Mask transform",
		maskPoints: "Polygon points (JSON)",
		maskPointsInvalid: "Mask points must be a JSON array of 3+ points.",
		shortcuts: "Shortcuts",
		shortcutsHelp: "Keyboard shortcuts",
		shortcutPlay: "Space — play / pause",
		shortcutSeek: "Left / Right — seek one frame",
		shortcutNudge: "Shift + Left / Right — nudge selected clip",
		shortcutUndo: "Cmd/Ctrl + Z — undo",
		shortcutRedo: "Cmd/Ctrl + Shift + Z — redo",
		shortcutDelete: "Delete — remove selected clip",
		shortcutSave: "Cmd/Ctrl + S — save project",
		shortcutExport: "Cmd/Ctrl + E — open export",
		shortcutHelp: "? — toggle this help",
		filePathUnavailable: "Browser file pickers do not expose an absolute path; type the path above instead.",
		effects: "Effects",
		keyframes: "Keyframes",
		masks: "Masks",
		captions: "Captions",
		captionText: "Caption text",
		captionTiming: "Timing",
		addCaption: "Add caption",
		saveCaption: "Save caption",
		captionsEmpty: "No caption clips yet.",
		captionGroup: "Caption group",
		addEffect: "Add effect",
		removeEffect: "Remove effect",
		effectEnabled: "Enabled",
		amount: "Amount",
		noEffects: "No effects on this clip.",
		addKeyframe: "Add keyframe",
		removeKeyframe: "Remove",
		noKeyframes: "No keyframes on this clip.",
		evaluate: "At frame",
		addRectMask: "Rectangle mask",
		addEllipseMask: "Ellipse mask",
		removeMask: "Remove mask",
		feather: "Feather",
		invertMask: "Invert",
		noMasks: "No masks on this clip.",
		play: "Play",
		pause: "Pause",
		stop: "Stop",
		importing: "Importing…",
		importMediaPath: "Media path",
		importMedia: "Import media",
		captionCreated: "Caption added.",
		captionUpdated: "Caption updated.",
		effectsHint: "Engine-supported effects: grayscale, sepia, invert.",
		keyframesHint: "Keyframes are engine-evaluated in preview/export; the readout is an interpolation preview.",
		masksHint: "Masks are intersected; edits replace the clip mask list.",
		inspect: "Inspect",
		inspector: "Inspector",
		export: "Export",
		settings: "Settings",
		close: "Close",
		properties: "Properties",
		opacity: "Opacity",
		volume: "Volume",
		positionX: "Position X",
		positionY: "Position Y",
		scaleWidth: "Width",
		scaleHeight: "Height",
		rotation: "Rotation",
		textContent: "Text",
		trackProperties: "Track",
		mute: "Mute",
		hide: "Hide",
		syncLock: "Sync lock",
		noSelection: "Select a clip to inspect it.",
		apply: "Apply",
		exportTitle: "Export video",
		outputPath: "Output path",
		codec: "Codec",
		quality: "Quality",
		range: "Frame range",
		rangeStart: "Start",
		rangeEnd: "End",
		bitDepth: "Bit depth",
		duckMusic: "Duck music",
		hdr10: "HDR10",
		exportNow: "Export",
		exporting: "Exporting…",
		exportStarting: "Starting export…",
		exportComplete: "Export complete",
		exportFailed: "Export failed",
		exportIdle: "Ready to export",
		settingsTitle: "Settings & storage",
		storage: "Storage",
		total: "Total",
		clearCache: "Clear cache",
		searchModel: "Search model",
		transcribeModel: "Transcription model",
		searchIndex: "Search index",
		notAvailable: "Not available",
		modelStatus: "models",
		refresh: "Refresh",
		cancel: "Cancel",
		inspectorEmpty: "Select a clip on the timeline.",
		exportHint: "Uses the existing /engine/invoke export_video IPC.",
		settingsHint: "Storage and model status come from the existing engine routes."
	}),
	zh: Object.freeze({
		appName: "OpenTake",
		nativePreview: "原生编辑器原型",
		home: "主页",
		editor: "编辑器",
		media: "素材",
		timeline: "时间线",
		preview: "预览",
		engine: "引擎",
		project: "项目",
		noProject: "尚未打开项目",
		newProject: "新建项目",
		openProject: "打开项目",
		saveProject: "保存项目",
		saveAs: "另存为",
		projectPath: "项目路径",
		recentUnavailable: "Host 尚未提供最近项目路由。",
		loading: "加载中…",
		retry: "重试",
		dismiss: "关闭",
		noMedia: "尚未导入素材。",
		noTracks: "暂无轨道。",
		selectClip: "选择一个片段",
		selected: "已选中",
		frame: "帧",
		previousFrame: "上一帧",
		nextFrame: "下一帧",
		moveLeft: "左移",
		moveRight: "右移",
		undo: "撤销",
		redo: "重做",
		refresh: "刷新",
		unavailable: "引擎不可用",
		tracks: "条轨道",
		clips: "个片段",
		duration: "时长",
		status: "状态",
		locale: "语言",
		theme: "主题",
		light: "浅色",
		dark: "深色",
		system: "跟随系统",
		clip: "片段",
		track: "轨道",
		start: "起点",
		engineReady: "已连接",
		engineDown: "未连接",
		importMedia: "导入素材",
		mediaCount: "{count} 个素材",
		projectVersion: "版本 {version}",
		busy: "处理中…",
		allChanges: "所有改动均由引擎持久化。",
		prototypeNotice: "有界的原生挂载：主页、素材、时间线和预览。完整编辑器仍保留在 iframe 回退中。",
		advanced: "高级",
		colorGrade: "调色",
		exposure: "曝光",
		temperature: "色温",
		contrast: "对比度",
		saturation: "饱和度",
		textStyle: "文字样式",
		fontName: "字体",
		fontSize: "字号",
		textColor: "颜色",
		chromaKey: "抠像",
		keyColor: "键控颜色",
		similarity: "相似度",
		spill: "溢色抑制",
		lut: "LUT",
		lutId: "LUT id（64 位十六进制）",
		lutName: "LUT 名称",
		lutIntensity: "LUT 强度",
		noLut: "未应用 LUT。",
		lutInvalid: "LUT id 必须为 64 位十六进制，名称不能为空。",
		remove: "移除",
		maskTransform: "蒙版变换",
		maskPoints: "多边形点（JSON）",
		maskPointsInvalid: "蒙版点必须是包含 3 个以上点的 JSON 数组。",
		shortcuts: "快捷键",
		shortcutsHelp: "键盘快捷键",
		shortcutPlay: "空格 — 播放 / 暂停",
		shortcutSeek: "左 / 右 — 前后一帧",
		shortcutNudge: "Shift + 左 / 右 — 移动选中片段",
		shortcutUndo: "Cmd/Ctrl + Z — 撤销",
		shortcutRedo: "Cmd/Ctrl + Shift + Z — 重做",
		shortcutDelete: "Delete — 删除选中片段",
		shortcutSave: "Cmd/Ctrl + S — 保存项目",
		shortcutExport: "Cmd/Ctrl + E — 打开导出",
		shortcutHelp: "? — 显示/隐藏帮助",
		filePathUnavailable: "浏览器文件选择器不提供绝对路径；请在上方输入路径。",
		effects: "效果",
		keyframes: "关键帧",
		masks: "蒙版",
		captions: "字幕",
		captionText: "字幕文本",
		captionTiming: "时间",
		addCaption: "添加字幕",
		saveCaption: "保存字幕",
		captionsEmpty: "暂无字幕片段。",
		captionGroup: "字幕组",
		addEffect: "添加效果",
		removeEffect: "移除效果",
		effectEnabled: "启用",
		amount: "强度",
		noEffects: "此片段没有效果。",
		addKeyframe: "添加关键帧",
		removeKeyframe: "移除",
		noKeyframes: "此片段没有关键帧。",
		evaluate: "当前帧",
		addRectMask: "矩形蒙版",
		addEllipseMask: "椭圆蒙版",
		removeMask: "移除蒙版",
		feather: "羽化",
		invertMask: "反转",
		noMasks: "此片段没有蒙版。",
		play: "播放",
		pause: "暂停",
		stop: "停止",
		importing: "导入中…",
		importMediaPath: "媒体路径",
		importMedia: "导入素材",
		captionCreated: "字幕已添加。",
		captionUpdated: "字幕已更新。",
		effectsHint: "引擎支持的效果：grayscale、sepia、invert。",
		keyframesHint: "关键帧由引擎在预览/导出中计算；此处读数仅为插值预览。",
		masksHint: "多个蒙版取交集；编辑会替换片段的蒙版列表。",
		inspect: "检查器",
		inspector: "检查器",
		export: "导出",
		settings: "设置",
		close: "关闭",
		properties: "属性",
		opacity: "不透明度",
		volume: "音量",
		positionX: "X 位置",
		positionY: "Y 位置",
		scaleWidth: "宽度",
		scaleHeight: "高度",
		rotation: "旋转",
		textContent: "文本",
		trackProperties: "轨道",
		mute: "静音",
		hide: "隐藏",
		syncLock: "同步锁定",
		noSelection: "选择一个片段进行检查。",
		apply: "应用",
		exportTitle: "导出视频",
		outputPath: "输出路径",
		codec: "编码",
		quality: "画质",
		range: "帧范围",
		rangeStart: "起点",
		rangeEnd: "终点",
		bitDepth: "位深",
		duckMusic: "音乐闪避",
		hdr10: "HDR10",
		exportNow: "导出",
		exporting: "导出中…",
		exportStarting: "正在启动导出…",
		exportComplete: "导出完成",
		exportFailed: "导出失败",
		exportIdle: "可以导出",
		settingsTitle: "设置与存储",
		storage: "存储",
		total: "总计",
		clearCache: "清理缓存",
		searchModel: "搜索模型",
		transcribeModel: "转写模型",
		searchIndex: "搜索索引",
		notAvailable: "不可用",
		modelStatus: "模型",
		refresh: "刷新",
		cancel: "取消",
		inspectorEmpty: "在时间线上选择一个片段。",
		exportHint: "使用现有的 /engine/invoke export_video IPC。",
		settingsHint: "存储和模型状态来自现有引擎路由。"
	})
});
function ee(e) {
	return typeof e == "string" && /^zh(?:-|$)/i.test(e) ? "zh" : "en";
}
function S(e = "en") {
	let t = ee(e), n = x[t], r = x.en;
	function i(e, t = void 0) {
		let i = n[e] ?? r[e] ?? e;
		return t == null ? i : i.replace(/\{([A-Za-z0-9_]+)\}/g, (e, n) => Object.prototype.hasOwnProperty.call(t, n) ? String(t[n]) : e);
	}
	return {
		locale: t,
		t: i
	};
}
//#endregion
//#region web/src/native/store.js
var te = 30;
function C(e) {
	return Array.isArray(e) ? e : [];
}
function ne(e) {
	return typeof e != "object" || !e ? [] : C((e.timeline !== null && typeof e.timeline == "object" ? e.timeline : e).tracks);
}
function re(e) {
	if (typeof e != "object" || !e) return {
		fps: te,
		width: 1920,
		height: 1080,
		projectPath: null,
		version: 0
	};
	let t = e.timeline !== null && typeof e.timeline == "object" ? e.timeline : e;
	return {
		fps: Number.isFinite(Number(t.fps)) ? Number(t.fps) : te,
		width: Number.isFinite(Number(t.width)) ? Number(t.width) : 1920,
		height: Number.isFinite(Number(t.height)) ? Number(t.height) : 1080,
		projectPath: typeof e.projectPath == "string" ? e.projectPath : null,
		version: Number.isFinite(Number(e.version)) ? Number(e.version) : 0
	};
}
function w(e, t) {
	if (typeof t != "string" || t.length === 0) return null;
	let n = ne(e);
	for (let e = 0; e < n.length; e += 1) {
		let r = n[e], i = C(r?.clips);
		for (let n = 0; n < i.length; n += 1) if (i[n]?.id === t) return {
			trackIndex: e,
			clipIndex: n,
			track: r,
			clip: i[n]
		};
	}
	return null;
}
function T(e) {
	let t = 0;
	for (let n of ne(e)) for (let e of C(n?.clips)) {
		let n = Number(e?.startFrame) || 0, r = Number(e?.durationFrames) || 0;
		t = Math.max(t, n + Math.max(0, r));
	}
	return Math.max(1, t);
}
function ie(e) {
	return ne(e).reduce((e, t) => e + C(t?.clips).length, 0);
}
function ae(e) {
	return Array.isArray(e) ? e : typeof e == "object" && e ? C(e.items) : [];
}
function oe(e) {
	let t = [];
	for (let [n, r] of ne(e).entries()) for (let [e, i] of C(r?.clips).entries()) typeof i?.captionGroupId == "string" && i.captionGroupId.length > 0 && t.push({
		trackIndex: n,
		clipIndex: e,
		track: r,
		clip: i
	});
	return t;
}
function se(e, t) {
	let n = C(e?.keyframes).filter((e) => Number.isFinite(Number(e?.frame)) && Number.isFinite(Number(e?.value))).map((e) => ({
		frame: Number(e.frame),
		value: Number(e.value)
	})).sort((e, t) => e.frame - t.frame);
	if (n.length === 0) return null;
	if (t <= n[0].frame) return n[0].value;
	if (t >= n[n.length - 1].frame) return n[n.length - 1].value;
	for (let e = 1; e < n.length; e += 1) {
		let r = n[e];
		if (t <= r.frame) {
			let i = n[e - 1], a = r.frame - i.frame;
			if (a <= 0) return r.value;
			let o = (t - i.frame) / a;
			return i.value + (r.value - i.value) * o;
		}
	}
	return n[n.length - 1].value;
}
function E(e = "clip") {
	let t = globalThis.crypto?.randomUUID?.();
	return t === void 0 ? `${e}-${Date.now()}-${Math.floor(Math.random() * 1e6)}` : `${e}-${t}`;
}
function D(e) {
	return e instanceof Error ? e.message : String(e);
}
function ce({ client: e, locale: t = "en", pollIntervalMs: n = 0, setIntervalImpl: r = globalThis.setInterval, clearIntervalImpl: i = globalThis.clearInterval } = {}) {
	if (typeof e != "object" || !e) throw TypeError("client is required");
	if (typeof r != "function" || typeof i != "function") throw TypeError("timer functions must be functions");
	let a = {
		view: "home",
		panel: "editor",
		locale: S(t).locale,
		theme: "system",
		ready: !1,
		loading: !1,
		busy: !1,
		error: null,
		info: null,
		timeline: null,
		media: [],
		selectedClipId: null,
		selectedMediaId: null,
		frame: 0,
		revision: 0,
		projectPath: null,
		engine: {
			connected: !1,
			loaded: !1,
			error: null
		},
		pollIntervalMs: n,
		settings: null,
		settingsLoading: !1,
		exportState: {
			active: !1,
			phase: "idle",
			done: 0,
			total: 0,
			error: null,
			summary: null
		},
		playback: {
			active: !1,
			paused: !1,
			frame: 0
		}
	}, o = /* @__PURE__ */ new Set(), s = null, c = null, l = null;
	function u() {
		for (let e of [...o]) try {
			e(a);
		} catch {}
	}
	function d(e) {
		return a = {
			...a,
			...e
		}, u(), a;
	}
	function f(e) {
		return {
			connected: typeof e == "object" && !!e,
			loaded: e?.loaded === !0,
			error: typeof e?.loadError == "string" ? e.loadError : null
		};
	}
	function p(e) {
		return { locale: S(e).locale };
	}
	async function m({ initial: t = !1 } = {}) {
		d({
			loading: t ? !0 : a.loading,
			error: t ? null : a.error
		});
		let [n, r, i] = await Promise.allSettled([
			e.info(),
			e.timeline(),
			e.media()
		]), o = [], s = n.status === "fulfilled" ? n.value : null, c = r.status === "fulfilled" ? r.value : null, l = i.status === "fulfilled" ? i.value : null;
		n.status === "rejected" && o.push(D(n.reason)), r.status === "rejected" && o.push(D(r.reason)), i.status === "rejected" && o.push(D(i.reason));
		let u = re(c), p = w(c, a.selectedClipId) !== null;
		return d({
			ready: !0,
			loading: !1,
			info: s,
			timeline: c,
			media: ae(l),
			projectPath: u.projectPath,
			frame: Math.min(a.frame, Math.max(0, T(c) - 1)),
			selectedClipId: p ? a.selectedClipId : null,
			selectedMediaId: ae(l).some((e) => e.id === a.selectedMediaId) ? a.selectedMediaId : null,
			engine: f(s),
			error: o.length > 0 ? o[0] : null
		});
	}
	async function h() {
		return m({ initial: !0 });
	}
	async function g() {
		return m();
	}
	async function _(t = null) {
		if (a.busy) return null;
		d({
			busy: !0,
			error: null
		});
		try {
			let n = await e.saveProject(t);
			return d({
				busy: !1,
				projectPath: typeof n?.path == "string" ? n.path : a.projectPath
			}), await g(), n;
		} catch (e) {
			return d({
				busy: !1,
				error: D(e)
			}), null;
		}
	}
	async function v(t) {
		if (a.busy) return null;
		d({
			busy: !0,
			error: null,
			view: "home"
		});
		try {
			let n = await e.openProject(t);
			return d({
				busy: !1,
				timeline: n,
				projectPath: re(n).projectPath,
				view: "editor",
				selectedClipId: null,
				frame: 0,
				revision: a.revision + 1
			}), await g(), n;
		} catch (e) {
			return d({
				busy: !1,
				error: D(e)
			}), null;
		}
	}
	async function y() {
		if (a.busy) return null;
		d({
			busy: !0,
			error: null,
			view: "home"
		});
		try {
			let t = await e.newProject();
			return d({
				busy: !1,
				timeline: t,
				projectPath: re(t).projectPath,
				view: "editor",
				selectedClipId: null,
				frame: 0,
				revision: a.revision + 1
			}), await g(), t;
		} catch (e) {
			return d({
				busy: !1,
				error: D(e)
			}), null;
		}
	}
	async function b(t) {
		if (a.busy) return null;
		if (typeof t != "object" || !t || Array.isArray(t)) return d({ error: "edit command must be an object" }), null;
		d({
			busy: !0,
			error: null
		});
		try {
			let n = await e.apply(t), r = await e.timeline();
			return d({
				busy: !1,
				timeline: r,
				projectPath: re(r).projectPath,
				revision: a.revision + 1,
				frame: Math.min(a.frame, Math.max(0, T(r) - 1))
			}), n;
		} catch (e) {
			return d({
				busy: !1,
				error: D(e)
			}), null;
		}
	}
	async function x(t) {
		if (a.busy) return null;
		d({
			busy: !0,
			error: null
		});
		try {
			let n = await (t === "undo" ? e.undo() : e.redo()), r = await e.timeline();
			return d({
				busy: !1,
				timeline: r,
				projectPath: re(r).projectPath,
				revision: a.revision + 1,
				selectedClipId: w(r, a.selectedClipId) === null ? null : a.selectedClipId,
				frame: Math.min(a.frame, Math.max(0, T(r) - 1))
			}), n;
		} catch (e) {
			return d({
				busy: !1,
				error: D(e)
			}), null;
		}
	}
	async function ee(e, t) {
		return typeof e != "string" || e.length === 0 ? (d({ error: "a selected clip is required" }), null) : typeof t != "object" || !t || Array.isArray(t) ? (d({ error: "clip properties must be an object" }), null) : b({
			type: "setClipProperties",
			clipIds: [e],
			properties: t
		});
	}
	async function te(e, t) {
		if (!Number.isInteger(e) || e < 0) return d({ error: "a valid track index is required" }), null;
		if (typeof t != "object" || !t || Array.isArray(t)) return d({ error: "track properties must be an object" }), null;
		let n = {
			type: "setTrackProps",
			trackIndex: e
		};
		return typeof t.muted == "boolean" && (n.muted = t.muted), typeof t.hidden == "boolean" && (n.hidden = t.hidden), typeof t.syncLocked == "boolean" && (n.syncLocked = t.syncLocked), n.muted === void 0 && n.hidden === void 0 && n.syncLocked === void 0 ? (d({ error: "no track property to change" }), null) : b(n);
	}
	function C(e) {
		let t = e === "export" || e === "settings" || e === "captions" ? e : "editor";
		d({ panel: t }), t === "settings" && oe();
	}
	function ne() {
		d({ panel: "editor" });
	}
	async function oe() {
		d({
			settingsLoading: !0,
			settings: a.settings
		});
		let [t, n, r, i] = await Promise.allSettled([
			e.invoke("storage_usage"),
			e.invoke("search_model_status"),
			e.invoke("transcribe_model_status"),
			e.invoke("search_index_status")
		]), o = [];
		function s(e) {
			return e.status === "fulfilled" ? e.value : (o.push(D(e.reason)), null);
		}
		d({
			settingsLoading: !1,
			settings: {
				storage: s(t),
				search: s(n),
				transcribe: s(r),
				searchIndex: s(i),
				error: o.length > 0 ? o[0] : null
			}
		});
	}
	async function se(t, { modelsConfirmed: n = !1 } = {}) {
		let r = Array.isArray(t) ? t.filter((e) => typeof e == "string") : [];
		if (r.length === 0) return null;
		try {
			let t = await e.invoke("storage_clear", {
				categories: r,
				modelsConfirmed: n === !0
			});
			return d({ settings: a.settings === null ? a.settings : {
				...a.settings,
				storage: t,
				error: null
			} }), t;
		} catch (e) {
			return d({ error: D(e) }), null;
		}
	}
	async function ce(t = {}) {
		if (a.exportState.active) return d({ error: "an export is already running" }), null;
		let n = typeof t.outPath == "string" ? t.outPath : "";
		if (n.length === 0) return d({ error: "export requires an output path" }), null;
		let o = {
			outPath: n,
			codec: [
				"h264",
				"h265",
				"prores",
				"prores4444"
			].includes(t.codec) ? t.codec : "h264",
			quality: [
				"720p",
				"1080p",
				"4k"
			].includes(t.quality) ? t.quality : "1080p",
			rangeStartFrame: Number.isInteger(t.rangeStartFrame) ? t.rangeStartFrame : null,
			rangeEndFrame: Number.isInteger(t.rangeEndFrame) ? t.rangeEndFrame : null,
			bitDepth: t.bitDepth === 10 ? 10 : 8,
			duckMusic: t.duckMusic === !0,
			hdr10: t.hdr10 === !0
		};
		d({ exportState: {
			active: !0,
			phase: "starting",
			done: 0,
			total: 0,
			error: null,
			summary: null
		} }), c = r(async () => {
			try {
				let t = await e.exportStatus();
				a.exportState.active && typeof t == "object" && t && d({ exportState: {
					...a.exportState,
					phase: t.active === !1 ? a.exportState.phase : "running",
					done: Number.isFinite(Number(t.done)) ? Number(t.done) : a.exportState.done,
					total: Number.isFinite(Number(t.total)) ? Number(t.total) : a.exportState.total
				} });
			} catch {}
		}, 500);
		try {
			let t = await e.invoke("export_video", {
				req: o,
				operationId: "native-export"
			});
			return d({ exportState: {
				active: !1,
				phase: "complete",
				done: a.exportState.done,
				total: a.exportState.total,
				error: null,
				summary: t
			} }), t;
		} catch (e) {
			return d({ exportState: {
				active: !1,
				phase: "error",
				done: a.exportState.done,
				total: a.exportState.total,
				error: D(e),
				summary: null
			} }), null;
		} finally {
			c !== null && (i(c), c = null);
		}
	}
	async function O() {
		try {
			return await e.invoke("cancel_export");
		} catch (e) {
			return d({ error: D(e) }), null;
		}
	}
	async function le(e, t) {
		return t !== null && (typeof t != "object" || Array.isArray(t)) ? (d({ error: "color grade must be an object or null" }), null) : b({
			type: "setColorGrade",
			clipIds: [e],
			grade: t
		});
	}
	async function k(e, t) {
		return t !== null && (typeof t != "object" || Array.isArray(t)) ? (d({ error: "LUT reference must be an object or null" }), null) : b({
			type: "setLut",
			clipIds: [e],
			lut: t
		});
	}
	async function ue(e, t) {
		return t !== null && (typeof t != "object" || Array.isArray(t)) ? (d({ error: "chroma key must be an object or null" }), null) : b({
			type: "setChromaKey",
			clipIds: [e],
			chromaKey: t
		});
	}
	async function de(e, t) {
		return typeof t != "object" || !t || Array.isArray(t) ? (d({ error: "text style must be an object" }), null) : b({
			type: "setClipProperties",
			clipIds: [e],
			properties: { textStyle: t }
		});
	}
	async function fe() {
		let e = w(a.timeline, a.selectedClipId);
		return e === null ? (d({ error: "select a clip before deleting it" }), null) : b({
			type: "removeClips",
			clipIds: [e.clip.id]
		});
	}
	function pe(e) {
		d({ error: typeof e == "string" ? e : String(e) });
	}
	async function me(e, t) {
		return Array.isArray(t) ? b({
			type: "setEffects",
			clipIds: [e],
			effects: t
		}) : (d({ error: "effects must be an array" }), null);
	}
	async function he(e, t) {
		return Array.isArray(t) ? b({
			type: "setMasks",
			clipIds: [e],
			masks: t
		}) : (d({ error: "masks must be an array" }), null);
	}
	async function ge(e, t, n, r) {
		let i = Math.trunc(Number(n));
		return !Number.isInteger(i) || i < 0 ? (d({ error: "keyframe frame must be a non-negative integer" }), null) : typeof r != "number" || !Number.isFinite(r) ? (d({ error: "keyframe value must be a finite number" }), null) : b({
			type: "upsertKeyframe",
			clipId: e,
			property: t,
			frame: i,
			value: {
				kind: "scalar",
				value: r
			}
		});
	}
	async function A(e, t, n) {
		let r = Math.trunc(Number(n));
		return !Number.isInteger(r) || r < 0 ? null : b({
			type: "removeKeyframe",
			clipId: e,
			property: t,
			frame: r
		});
	}
	async function _e({ content: e, startFrame: t = 0, durationFrames: n = 60 } = {}) {
		let r = typeof e == "string" ? e.trim() : "";
		return r.length === 0 ? (d({ error: "caption text must not be empty" }), null) : b({
			type: "addCaptions",
			entries: [{
				startFrame: Math.max(0, Math.trunc(Number(t)) || 0),
				durationFrames: Math.max(1, Math.trunc(Number(n)) || 60),
				content: r,
				captionGroupId: `captions-native-${E("group").split("-").pop()}`,
				textStyle: {
					fontName: "Helvetica-Bold",
					fontSize: 48,
					fontScale: 1,
					color: {
						r: 1,
						g: 1,
						b: 1,
						a: 1
					},
					alignment: "center",
					shadow: {
						enabled: !1,
						color: {
							r: 0,
							g: 0,
							b: 0,
							a: 0
						},
						offsetX: 0,
						offsetY: 0,
						blur: 0
					},
					background: {
						enabled: !1,
						color: {
							r: 0,
							g: 0,
							b: 0,
							a: 0
						}
					},
					border: {
						enabled: !1,
						color: {
							r: 0,
							g: 0,
							b: 0,
							a: 1
						}
					}
				},
				transform: {
					centerX: .5,
					centerY: .85,
					width: .9,
					height: .2,
					rotation: 0,
					flipHorizontal: !1,
					flipVertical: !1
				}
			}]
		});
	}
	async function ve(e, { content: t, startFrame: n, durationFrames: r } = {}) {
		let i = w(a.timeline, e);
		if (i === null) return d({ error: "caption clip not found" }), null;
		let o = {};
		return typeof t == "string" && (o.textContent = t), Number.isFinite(Number(r)) && (o.durationFrames = Math.max(1, Math.trunc(Number(r)))), Object.keys(o).length > 0 && await b({
			type: "setClipProperties",
			clipIds: [e],
			properties: o
		}) === null ? null : Number.isFinite(Number(n)) ? b({
			type: "moveClips",
			moves: [{
				clipId: e,
				toTrack: i.trackIndex,
				toFrame: Math.max(0, Math.trunc(Number(n)))
			}]
		}) : null;
	}
	async function ye(t) {
		let n = Array.isArray(t) ? t.filter((e) => typeof e == "string" && e.trim().length > 0) : [];
		if (n.length === 0) return d({ error: "enter one or more media paths to import" }), null;
		d({
			busy: !0,
			error: null
		});
		try {
			let t = await e.importMedia(n);
			return d({
				busy: !1,
				media: ae(t)
			}), t;
		} catch (e) {
			return d({
				busy: !1,
				error: D(e)
			}), null;
		}
	}
	async function j() {
		if (!(a.playback.active && a.playback.paused === !1)) try {
			let t = a.timeline ?? {};
			await e.invoke("playback_start", {
				fromFrame: a.frame,
				identity: {
					projectEpoch: Number(t.projectEpoch) || 0,
					timelineVersion: Number(t.version) || 0,
					sessionId: "route-b-native"
				}
			}), d({ playback: {
				active: !0,
				paused: !1,
				frame: a.frame
			} }), l !== null && i(l), l = r(async () => {
				try {
					let t = await e.playbackStatus();
					if (t === null || t.active !== !0) {
						be(), d({ playback: {
							active: !1,
							paused: !0,
							frame: a.frame
						} });
						return;
					}
					let n = Math.max(0, Math.trunc(Number(t.frame) || 0));
					d({
						frame: n,
						playback: {
							active: !0,
							paused: t.paused === !0,
							frame: n
						}
					}), (t.terminal === !0 || t.active === !1) && (be(), d({ playback: {
						active: !1,
						paused: !0,
						frame: n
					} }));
				} catch {
					be(), d({ playback: {
						active: !1,
						paused: !0,
						frame: a.frame
					} });
				}
			}, 200);
		} catch (e) {
			d({ error: D(e) });
		}
	}
	function be() {
		l !== null && (i(l), l = null);
	}
	async function xe() {
		be();
		try {
			await e.invoke("playback_pause", { frame: a.frame });
		} catch (e) {
			d({ error: D(e) });
		}
		d({ playback: {
			active: a.playback.active,
			paused: !0,
			frame: a.frame
		} });
	}
	async function Se(t) {
		let n = Number.isFinite(Number(t)) ? Math.trunc(Number(t)) : 0;
		if (d({
			frame: Math.max(0, n),
			playback: {
				...a.playback,
				frame: Math.max(0, n)
			}
		}), a.playback.active) try {
			await e.invoke("playback_seek", { frame: Math.max(0, n) });
		} catch (e) {
			d({ error: D(e) });
		}
	}
	async function Ce() {
		be();
		try {
			await e.invoke("playback_stop");
		} catch {}
		d({ playback: {
			active: !1,
			paused: !1,
			frame: a.frame
		} });
	}
	function we(e) {
		d({ selectedClipId: typeof e == "string" && w(a.timeline, e) ? e : null });
	}
	function Te(e) {
		d({ selectedMediaId: typeof e == "string" && ae(a.media).some((t) => t.id === e) ? e : null });
	}
	function Ee(e) {
		let t = Number.isFinite(Number(e)) ? Math.trunc(Number(e)) : 0;
		d({ frame: Math.min(Math.max(0, t), Math.max(0, T(a.timeline) - 1)) });
	}
	async function De(e) {
		let t = w(a.timeline, a.selectedClipId);
		if (t === null) return d({ error: "select a clip before moving it" }), null;
		let n = Math.trunc(Number(e) || 0);
		if (n === 0) return null;
		let r = Math.max(0, Number(t.clip.startFrame) + n);
		return b({
			type: "moveClips",
			moves: [{
				clipId: t.clip.id,
				toTrack: t.trackIndex,
				toFrame: r
			}]
		});
	}
	function Oe(e) {
		d({ view: e === "editor" ? "editor" : "home" });
	}
	function ke(e) {
		d(p(e));
	}
	function Ae(e) {
		d({ theme: e === "light" || e === "dark" ? e : "system" });
	}
	function je() {
		d({ error: null });
	}
	function Me(t = a.pollIntervalMs) {
		Ne();
		let n = Number(t);
		!Number.isFinite(n) || n < 250 || (d({ pollIntervalMs: n }), s = r(async () => {
			if (!a.busy) try {
				let [t, n] = await Promise.all([e.timeline(), e.media()]), r = re(t);
				d({
					timeline: t,
					media: ae(n),
					projectPath: r.projectPath,
					selectedClipId: w(t, a.selectedClipId) === null ? null : a.selectedClipId,
					frame: Math.min(a.frame, Math.max(0, T(t) - 1))
				});
			} catch (e) {
				d({ error: D(e) });
			}
		}, n));
	}
	function Ne() {
		s !== null && (i(s), s = null);
	}
	function Pe() {
		Ne(), c !== null && (i(c), c = null), be(), o.clear();
	}
	return {
		getSnapshot: () => a,
		subscribe(e) {
			if (typeof e != "function") throw TypeError("listener must be a function");
			return o.add(e), () => o.delete(e);
		},
		initialize: h,
		refresh: g,
		newProject: y,
		openProject: v,
		saveProject: _,
		apply: b,
		undo: () => x("undo"),
		redo: () => x("redo"),
		selectClip: we,
		selectMedia: Te,
		setClipProperties: ee,
		setTrackProperties: te,
		setClipEffects: me,
		setClipMasks: he,
		setColorGrade: le,
		setLut: k,
		setChromaKey: ue,
		setTextStyle: de,
		removeSelected: fe,
		setError: pe,
		upsertKeyframe: ge,
		removeKeyframe: A,
		addCaption: _e,
		updateCaption: ve,
		importMedia: ye,
		play: j,
		pause: xe,
		seekTo: Se,
		stopPlayback: Ce,
		openPanel: C,
		closePanel: ne,
		refreshSettings: oe,
		clearStorage: se,
		exportVideo: ce,
		cancelExport: O,
		setFrame: Ee,
		moveSelected: De,
		setView: Oe,
		setLocale: ke,
		setTheme: Ae,
		clearError: je,
		startPolling: Me,
		stopPolling: Ne,
		dispose: Pe,
		clipCount: () => ie(a.timeline),
		totalFrames: () => T(a.timeline)
	};
}
//#endregion
//#region web/src/native/components.js
var O = (e, t, n, ...r) => e.createElement(t, n, ...r);
function le(e, t) {
	if (typeof e.useSyncExternalStore == "function") return e.useSyncExternalStore(t.subscribe, t.getSnapshot, t.getSnapshot);
	let [n, r] = e.useState(t.getSnapshot());
	return e.useEffect(() => t.subscribe(r), [t]), n;
}
function k(e, t, n, r = {}) {
	return O(e, "button", {
		type: "button",
		className: `otn-btn${r.primary ? " otn-btn--primary" : ""}`,
		onClick: n,
		disabled: r.disabled === !0,
		title: r.title,
		"aria-label": r.ariaLabel
	}, t);
}
function ue(e, t, n) {
	let r = t.engine?.connected === !0;
	return O(e, "span", {
		className: `otn-badge${r ? "" : " otn-badge--down"}`,
		title: t.engine?.error ?? void 0
	}, O(e, "span", {
		className: `otn-dot${r ? "" : " otn-dot--down"}`,
		"aria-hidden": "true"
	}), n(r ? "engineReady" : "engineDown"));
}
function de(e, t, n, r) {
	return typeof t.error != "string" || t.error.length === 0 ? null : O(e, "div", {
		className: "otn-error",
		role: "alert"
	}, O(e, "span", { className: "otn-error__message" }, t.error), k(e, r("retry"), () => {
		n.refresh();
	}), k(e, r("dismiss"), () => n.clearError(), { ariaLabel: r("dismiss") }));
}
function fe({ React: e, state: t, store: n, client: r, t: i }) {
	let [a, o] = e.useState(t.projectPath ?? "");
	e.useEffect(() => {
		t.projectPath !== null && t.projectPath !== a && o(t.projectPath);
	}, [t.projectPath]);
	let s = t.busy || t.loading;
	function c(e) {
		e.preventDefault(), a.trim().length !== 0 && n.openProject(a.trim());
	}
	let l = t.info;
	return O(e, "section", {
		className: "otn-home",
		"aria-label": i("home")
	}, O(e, "div", null, O(e, "h1", { className: "otn-home__title" }, i("appName")), O(e, "p", { className: "otn-home__subtitle" }, i("prototypeNotice"))), O(e, "div", { className: "otn-card" }, O(e, "div", { className: "otn-panel-title" }, i("engine")), O(e, "div", { className: "otn-kv" }, O(e, "span", null, i("status")), O(e, "span", { className: "otn-kv__value" }, ue(e, t, i)), O(e, "span", null, i("locale")), O(e, "span", { className: "otn-kv__value" }, t.locale), O(e, "span", null, "Node"), O(e, "span", { className: "otn-kv__value" }, l?.node ?? "—"), O(e, "span", null, "N-API"), O(e, "span", { className: "otn-kv__value" }, l?.napi ?? "—")), l?.loadError ? O(e, "p", { className: "otn-hint" }, l.loadError) : null), O(e, "form", {
		className: "otn-card",
		onSubmit: c
	}, O(e, "div", { className: "otn-panel-title" }, i("openProject")), O(e, "div", { className: "otn-home__row" }, O(e, "input", {
		className: "otn-input",
		value: a,
		placeholder: i("projectPath"),
		onChange: (e) => o(e.target.value),
		"aria-label": i("projectPath"),
		spellCheck: !1
	}), k(e, i("openProject"), () => {
		n.openProject(a.trim());
	}, { disabled: s || a.trim().length === 0 }), k(e, i("newProject"), () => {
		n.newProject();
	}, {
		primary: !0,
		disabled: s
	})), O(e, "p", { className: "otn-hint" }, i("recentUnavailable"))), O(e, "div", { className: "otn-card" }, O(e, "div", { className: "otn-panel-title" }, i("media")), O(e, "p", { className: "otn-hint" }, i("mediaCount", { count: t.media.length })), O(e, "div", { className: "otn-home__row" }, k(e, i("editor"), () => n.setView("editor"), { disabled: t.timeline === null }), k(e, i("refresh"), () => {
		n.refresh();
	}, { disabled: s }))), O(e, "p", { className: "otn-hint" }, i("allChanges")));
}
function pe(e, { state: t, client: n, t: r, store: i }) {
	let a = t.media;
	return O(e, "aside", {
		className: "otn-media",
		"aria-label": r("media")
	}, O(e, "div", { className: "otn-panel-title" }, O(e, "span", null, r("media")), O(e, "span", null, String(a.length))), O(e, "form", {
		className: "otn-media-import",
		onSubmit: (e) => {
			e.preventDefault();
			let t = e.currentTarget.elements.nativeImportPath, n = typeof t?.value == "string" ? t.value.trim() : "";
			n.length > 0 && (i.importMedia([n]), t.value = "");
		}
	}, O(e, "input", {
		className: "otn-input",
		name: "nativeImportPath",
		placeholder: r("importMediaPath"),
		"aria-label": r("importMediaPath"),
		spellCheck: !1,
		"data-otn-import-path": ""
	}), O(e, "button", {
		type: "submit",
		className: "otn-btn",
		disabled: t.busy,
		"data-otn-action": "import-media"
	}, t.busy ? r("importing") : r("importMedia")), O(e, "input", {
		type: "file",
		className: "otn-file-picker",
		"data-otn-file-picker": "",
		onChange: (e) => {
			let t = e.target.files?.[0] ?? null, n = typeof t?.path == "string" ? t.path : "";
			n.length > 0 ? i.importMedia([n]) : i.setError(r("filePathUnavailable")), e.target.value = "";
		}
	})), a.length === 0 ? O(e, "p", { className: "otn-empty" }, r("noMedia")) : O(e, "ul", { className: "otn-media-list" }, a.map((r) => {
		let a = typeof r.name == "string" && r.name.length > 0 ? r.name : r.id, o = typeof r.type == "string" ? r.type : "media", s = typeof r.path == "string" ? n.assetUrl(r.path) : null;
		return O(e, "li", { key: String(r.id) }, O(e, "button", {
			type: "button",
			className: `otn-media-card${t.selectedMediaId === r.id ? " otn-media-card--selected" : ""}`,
			title: a,
			"aria-pressed": t.selectedMediaId === r.id,
			onClick: () => i.selectMedia(r.id)
		}, s ? O(e, "img", {
			className: "otn-media-thumb",
			src: s,
			alt: "",
			loading: "lazy",
			onError: (e) => {
				e.currentTarget.style.visibility = "hidden";
			}
		}) : O(e, "span", {
			className: "otn-media-thumb otn-media-thumb--empty",
			"aria-hidden": "true"
		}, o.slice(0, 4).toUpperCase()), O(e, "span", { className: "otn-media-copy" }, O(e, "span", { className: "otn-media-name" }, a), O(e, "span", { className: "otn-media-meta" }, `${o}${Number.isFinite(Number(r.duration)) ? ` · ${Number(r.duration).toFixed(1)}s` : ""}`))));
	})));
}
function me(e, { state: t, client: n, store: r, t: i }) {
	let a = re(t.timeline), o = Math.max(0, T(t.timeline) - 1), s = Math.min(t.frame, o), c = t.timeline !== null;
	return O(e, "section", {
		className: "otn-preview",
		"aria-label": i("preview")
	}, O(e, "div", { className: "otn-preview-stage" }, c ? O(e, "img", {
		className: "otn-preview-image",
		src: n.previewUrl(s, { revision: t.revision }),
		alt: `${i("preview")} ${i("frame")} ${s}`,
		draggable: !1
	}) : O(e, "div", { className: "otn-preview-placeholder" }, i("noProject"))), O(e, "div", {
		className: "otn-transport",
		"data-otn-playback": t.playback.active ? t.playback.paused ? "paused" : "playing" : "idle"
	}, k(e, "◀", () => {
		r.seekTo(Math.max(0, s - 1));
	}, {
		ariaLabel: i("previousFrame"),
		disabled: s <= 0,
		title: i("previousFrame")
	}), O(e, "button", {
		type: "button",
		className: "otn-btn otn-btn--icon",
		"data-otn-action": "playback-toggle",
		"aria-label": t.playback.active && !t.playback.paused ? i("pause") : i("play"),
		title: t.playback.active && !t.playback.paused ? i("pause") : i("play"),
		onClick: () => {
			t.playback.active && !t.playback.paused ? r.pause() : r.play();
		}
	}, t.playback.active && !t.playback.paused ? "❚❚" : "▶"), O(e, "button", {
		type: "button",
		className: "otn-btn otn-btn--icon",
		"data-otn-action": "playback-stop",
		"aria-label": i("stop"),
		title: i("stop"),
		onClick: () => {
			r.stopPlayback();
		}
	}, "■"), O(e, "input", {
		className: "otn-scrub",
		type: "range",
		min: 0,
		max: Math.max(0, o),
		value: s,
		onChange: (e) => {
			r.seekTo(Number(e.target.value));
		},
		"aria-label": i("frame")
	}), k(e, "▶", () => {
		r.seekTo(Math.min(o, s + 1));
	}, {
		ariaLabel: i("nextFrame"),
		disabled: s >= o,
		title: i("nextFrame")
	}), O(e, "span", { className: "otn-frame-readout" }, `${i("frame")} ${s} / ${o} · ${a.fps}fps`)));
}
function he(e, t) {
	if (typeof t?.textContent == "string" && t.textContent.length > 0) return t.textContent.slice(0, 40);
	let n = e?.name;
	return typeof n == "string" && n.length > 0 ? n : typeof t?.id == "string" ? t.id.slice(0, 18) : "clip";
}
function ge(e, { state: t, store: n, t: r }) {
	let i = ne(t.timeline), a = T(t.timeline), o = w(t.timeline, t.selectedClipId), s = new Map(ae(t.media).map((e) => [e.id, e])), c = [
		0,
		.25,
		.5,
		.75,
		1
	].map((e) => Math.round(e * a));
	return O(e, "section", {
		className: "otn-timeline",
		"aria-label": r("timeline")
	}, O(e, "div", { className: "otn-timeline-toolbar" }, O(e, "strong", null, r("timeline")), O(e, "span", { className: "otn-hint" }, `${i.length} ${r("tracks")} · ${ie(t.timeline)} ${r("clips")}`), O(e, "span", { className: "otn-spacer" }), k(e, r("undo"), () => {
		n.undo();
	}, { disabled: t.busy }), k(e, r("redo"), () => {
		n.redo();
	}, { disabled: t.busy }), k(e, r("moveLeft"), () => {
		n.moveSelected(-1);
	}, {
		disabled: t.busy || o === null,
		title: `${r("moveLeft")} (${r("clip")})`
	}), k(e, r("moveRight"), () => {
		n.moveSelected(1);
	}, {
		disabled: t.busy || o === null,
		title: `${r("moveRight")} (${r("clip")})`
	}), O(e, "span", { className: "otn-frame-readout" }, o === null ? r("selectClip") : `${r("selected")}: ${he(s.get(o.clip.mediaRef), o.clip)}`)), O(e, "div", { className: "otn-timeline-body" }, O(e, "div", {
		className: "otn-ruler",
		"aria-hidden": "true"
	}, c.map((t, n) => O(e, "span", {
		key: `tick-${n}`,
		className: "otn-ruler-tick",
		style: { left: `${t / a * 100}%` }
	}, O(e, "span", { className: "otn-ruler-label" }, String(t))))), i.length === 0 ? O(e, "p", { className: "otn-empty" }, r("noTracks")) : i.map((r, i) => O(e, "div", {
		key: r.id ?? `track-${i}`,
		className: "otn-track-row"
	}, O(e, "div", {
		className: "otn-track-head",
		title: r.id ?? ""
	}, O(e, "span", null, `${String(r.type ?? "video").toLowerCase() === "audio" ? "A" : "V"}${i + 1}`)), O(e, "div", { className: "otn-track-lane" }, (Array.isArray(r.clips) ? r.clips : []).map((r, o) => {
		let c = Number(r.startFrame) || 0, l = Math.max(1, Number(r.durationFrames) || 1), u = Math.max(0, c / a * 100), d = Math.max(.4, l / a * 100), f = r.id === t.selectedClipId, p = he(s.get(r.mediaRef), r);
		return O(e, "button", {
			key: r.id ?? `clip-${i}-${o}`,
			type: "button",
			className: `otn-clip${f ? " otn-clip--selected" : ""}`,
			style: {
				left: `${u}%`,
				width: `${d}%`
			},
			onClick: () => n.selectClip(r.id),
			title: `${p} · ${c}+${l}`
		}, p);
	}))))));
}
function A(e, { label: t, value: n, onChange: r, onBlur: i, min: a, max: o, step: s, dataKey: c }) {
	return O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, t), O(e, "input", {
		className: "otn-field__input",
		type: "number",
		value: n,
		min: a,
		max: o,
		step: s ?? 1,
		"data-otn-inspector-field": c,
		onChange: (e) => r(e.target.value),
		onBlur: i,
		onKeyDown: (e) => {
			e.key === "Enter" && e.currentTarget.blur();
		}
	}));
}
function _e({ React: e, state: t, store: n, t: r }) {
	let i = w(t.timeline, t.selectedClipId), a = i?.clip ?? null, o = a?.id ?? "", s = a?.transform ?? {}, [c, l] = e.useState({
		opacity: "",
		volume: "",
		centerX: "",
		centerY: "",
		width: "",
		height: "",
		rotation: "",
		textContent: ""
	}), [u, d] = e.useState("properties");
	if (e.useEffect(() => {
		if (a === null) {
			l({
				opacity: "",
				volume: "",
				centerX: "",
				centerY: "",
				width: "",
				height: "",
				rotation: "",
				textContent: ""
			});
			return;
		}
		l({
			opacity: String(a.opacity ?? 1),
			volume: String(a.volume ?? 1),
			centerX: String(a.transform?.centerX ?? .5),
			centerY: String(a.transform?.centerY ?? .5),
			width: String(a.transform?.width ?? 1),
			height: String(a.transform?.height ?? 1),
			rotation: String(a.transform?.rotation ?? 0),
			textContent: typeof a.textContent == "string" ? a.textContent : ""
		});
	}, [
		o,
		a?.opacity,
		a?.volume,
		a?.transform?.centerX,
		a?.transform?.centerY,
		a?.transform?.width,
		a?.transform?.height,
		a?.transform?.rotation,
		a?.textContent
	]), i === null || a === null) return O(e, "aside", {
		className: "otn-inspector",
		"aria-label": r("inspector")
	}, O(e, "div", { className: "otn-panel-title" }, r("inspector")), O(e, "p", { className: "otn-empty" }, r("inspectorEmpty")));
	let f = i.track, p = i.trackIndex, m = t.busy;
	function h(e, t) {
		l((n) => ({
			...n,
			[e]: t
		}));
	}
	function g(e, t) {
		let r = Number(c[e]);
		if (!Number.isFinite(r)) return;
		let i = e === "opacity" || e === "volume" ? Math.min(1, Math.max(0, r)) : r;
		i !== Number(a[t]) && n.setClipProperties(a.id, { [t]: i });
	}
	function _(e) {
		let t = Number(c[e]);
		Number.isFinite(t) && t !== Number(s[e] ?? 0) && n.setClipProperties(a.id, { transform: {
			...s,
			[e]: t
		} });
	}
	function v() {
		typeof a.textContent == "string" && c.textContent !== a.textContent && n.setClipProperties(a.id, { textContent: c.textContent });
	}
	return O(e, "aside", {
		className: "otn-inspector",
		"aria-label": r("inspector")
	}, O(e, "div", { className: "otn-panel-title" }, r("inspector"), O(e, "span", null, he(null, a))), O(e, "div", { className: "otn-inspector__body" }, O(e, "div", {
		className: "otn-inspector__tabs",
		role: "tablist"
	}, [
		"properties",
		"effects",
		"keyframes",
		"masks",
		"advanced"
	].map((t) => O(e, "button", {
		key: t,
		type: "button",
		role: "tab",
		className: `otn-inspector__tab${u === t ? " otn-inspector__tab--active" : ""}`,
		"aria-selected": u === t,
		"data-otn-inspector-tab": t,
		onClick: () => d(t)
	}, r(t === "properties" ? "properties" : t)))), O(e, "div", { hidden: u !== "properties" }, O(e, "div", { className: "otn-inspector__group" }, O(e, "span", { className: "otn-inspector__title" }, r("properties")), A(e, {
		label: r("opacity"),
		value: c.opacity,
		dataKey: "opacity",
		min: 0,
		max: 1,
		step: .01,
		onChange: (e) => h("opacity", e),
		onBlur: () => g("opacity", "opacity")
	}), A(e, {
		label: r("volume"),
		value: c.volume,
		dataKey: "volume",
		min: 0,
		max: 1,
		step: .01,
		onChange: (e) => h("volume", e),
		onBlur: () => g("volume", "volume")
	})), O(e, "div", { className: "otn-inspector__group" }, O(e, "span", { className: "otn-inspector__title" }, `${r("positionX")} / ${r("positionY")}`), O(e, "div", { className: "otn-field__row" }, A(e, {
		label: r("positionX"),
		value: c.centerX,
		dataKey: "centerX",
		min: 0,
		max: 1,
		step: .01,
		onChange: (e) => h("centerX", e),
		onBlur: () => _("centerX")
	}), A(e, {
		label: r("positionY"),
		value: c.centerY,
		dataKey: "centerY",
		min: 0,
		max: 1,
		step: .01,
		onChange: (e) => h("centerY", e),
		onBlur: () => _("centerY")
	})), O(e, "div", { className: "otn-field__row" }, A(e, {
		label: r("scaleWidth"),
		value: c.width,
		dataKey: "width",
		min: .01,
		max: 8,
		step: .01,
		onChange: (e) => h("width", e),
		onBlur: () => _("width")
	}), A(e, {
		label: r("scaleHeight"),
		value: c.height,
		dataKey: "height",
		min: .01,
		max: 8,
		step: .01,
		onChange: (e) => h("height", e),
		onBlur: () => _("height")
	})), A(e, {
		label: r("rotation"),
		value: c.rotation,
		dataKey: "rotation",
		min: -360,
		max: 360,
		step: 1,
		onChange: (e) => h("rotation", e),
		onBlur: () => _("rotation")
	})), typeof a.textContent == "string" ? O(e, "div", { className: "otn-inspector__group" }, O(e, "span", { className: "otn-inspector__title" }, r("textContent")), O(e, "textarea", {
		className: "otn-field__input",
		rows: 3,
		value: c.textContent,
		"data-otn-inspector-field": "textContent",
		onChange: (e) => h("textContent", e.target.value),
		onBlur: v
	})) : null, O(e, "div", { className: "otn-inspector__group" }, O(e, "span", { className: "otn-inspector__title" }, r("trackProperties")), O(e, "span", { className: "otn-inspector__track-name" }, `${r("track")} ${p + 1} · ${String(f.type ?? "video")}`), O(e, "div", { className: "otn-field__row" }, O(e, "button", {
		type: "button",
		className: "otn-toggle",
		disabled: m,
		"aria-pressed": f.muted === !0,
		"data-otn-track-prop": "muted",
		onClick: () => {
			n.setTrackProperties(p, { muted: f.muted !== !0 });
		}
	}, r("mute")), O(e, "button", {
		type: "button",
		className: "otn-toggle",
		disabled: m,
		"aria-pressed": f.hidden === !0,
		"data-otn-track-prop": "hidden",
		onClick: () => {
			n.setTrackProperties(p, { hidden: f.hidden !== !0 });
		}
	}, r("hide")), O(e, "button", {
		type: "button",
		className: "otn-toggle",
		disabled: m,
		"aria-pressed": f.syncLocked === !0,
		"data-otn-track-prop": "syncLocked",
		onClick: () => {
			n.setTrackProperties(p, { syncLocked: f.syncLocked !== !0 });
		}
	}, r("syncLock"))))), O(e, "div", { hidden: u !== "effects" }, O(e, Ce, {
		React: e,
		clip: a,
		store: n,
		t: r,
		disabled: m
	})), O(e, "div", { hidden: u !== "keyframes" }, O(e, we, {
		React: e,
		state: t,
		clip: a,
		store: n,
		t: r,
		disabled: m
	})), O(e, "div", { hidden: u !== "masks" }, O(e, Ee, {
		React: e,
		clip: a,
		store: n,
		t: r,
		disabled: m
	})), O(e, "div", { hidden: u !== "advanced" }, O(e, be, {
		React: e,
		clip: a,
		store: n,
		t: r,
		disabled: m
	}))));
}
var ve = {
	exposure: 0,
	temperature: 0,
	tint: 0,
	liftGammaGain: {
		lift: {
			r: 0,
			g: 0,
			b: 0
		},
		gamma: {
			r: 1,
			g: 1,
			b: 1
		},
		gain: {
			r: 1,
			g: 1,
			b: 1
		}
	},
	contrast: 0,
	saturation: 1,
	hslSecondary: null
}, ye = {
	fontName: "Helvetica-Bold",
	fontSize: 48,
	fontScale: 1,
	color: {
		r: 1,
		g: 1,
		b: 1,
		a: 1
	},
	alignment: "center",
	shadow: {
		enabled: !1,
		color: {
			r: 0,
			g: 0,
			b: 0,
			a: 0
		},
		offsetX: 0,
		offsetY: 0,
		blur: 0
	},
	background: {
		enabled: !1,
		color: {
			r: 0,
			g: 0,
			b: 0,
			a: 0
		}
	},
	border: {
		enabled: !1,
		color: {
			r: 0,
			g: 0,
			b: 0,
			a: 1
		}
	}
};
function j(e, t, n) {
	let r = e.elements[t]?.value, i = Number(r);
	return Number.isFinite(i) ? i : n;
}
function be({ React: e, clip: t, store: n, t: r, disabled: i }) {
	let a = t.colorGrade ?? ve, o = t.textStyle ?? ye, s = t.chromaKey ?? null, c = t.lut ?? null;
	return O(e, "div", {
		className: "otn-inspector__group",
		"data-otn-advanced": ""
	}, O(e, "span", { className: "otn-inspector__title" }, r("advanced")), O(e, "form", {
		className: "otn-advanced-card",
		"data-otn-advanced-section": "colorGrade",
		onSubmit: (e) => {
			e.preventDefault();
			let r = e.currentTarget;
			n.setColorGrade(t.id, {
				...ve,
				...a,
				exposure: j(r, "exposure", a.exposure ?? 0),
				temperature: j(r, "temperature", a.temperature ?? 0),
				tint: j(r, "tint", a.tint ?? 0),
				contrast: j(r, "contrast", a.contrast ?? 0),
				saturation: j(r, "saturation", a.saturation ?? 1),
				liftGammaGain: a.liftGammaGain ?? ve.liftGammaGain,
				hslSecondary: a.hslSecondary ?? null
			});
		}
	}, O(e, "span", { className: "otn-inspector__title" }, r("colorGrade")), O(e, "div", { className: "otn-field__row" }, O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("exposure")), O(e, "input", {
		className: "otn-field__input",
		name: "exposure",
		type: "number",
		step: .1,
		min: -5,
		max: 5,
		defaultValue: String(a.exposure ?? 0),
		"data-otn-grade-field": "exposure"
	})), O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("contrast")), O(e, "input", {
		className: "otn-field__input",
		name: "contrast",
		type: "number",
		step: .05,
		min: -1,
		max: 2,
		defaultValue: String(a.contrast ?? 0),
		"data-otn-grade-field": "contrast"
	}))), O(e, "div", { className: "otn-field__row" }, O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("temperature")), O(e, "input", {
		className: "otn-field__input",
		name: "temperature",
		type: "number",
		step: .05,
		min: -1,
		max: 1,
		defaultValue: String(a.temperature ?? 0),
		"data-otn-grade-field": "temperature"
	})), O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("tint")), O(e, "input", {
		className: "otn-field__input",
		name: "tint",
		type: "number",
		step: .05,
		min: -1,
		max: 1,
		defaultValue: String(a.tint ?? 0),
		"data-otn-grade-field": "tint"
	})), O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("saturation")), O(e, "input", {
		className: "otn-field__input",
		name: "saturation",
		type: "number",
		step: .05,
		min: 0,
		max: 3,
		defaultValue: String(a.saturation ?? 1),
		"data-otn-grade-field": "saturation"
	}))), O(e, "div", { className: "otn-field__row" }, O(e, "button", {
		type: "submit",
		className: "otn-btn",
		disabled: i,
		"data-otn-action": "grade-apply"
	}, r("apply")), t.colorGrade !== null && t.colorGrade !== void 0 ? O(e, "button", {
		type: "button",
		className: "otn-toggle",
		disabled: i,
		"data-otn-action": "grade-remove",
		onClick: () => {
			n.setColorGrade(t.id, null);
		}
	}, r("remove")) : null)), O(e, "form", {
		className: "otn-advanced-card",
		"data-otn-advanced-section": "textStyle",
		onSubmit: (e) => {
			e.preventDefault();
			let r = e.currentTarget;
			n.setTextStyle(t.id, {
				...ye,
				...o,
				fontName: String(r.elements.fontName?.value ?? o.fontName ?? "Helvetica-Bold"),
				fontSize: j(r, "fontSize", o.fontSize ?? 48),
				fontScale: j(r, "fontScale", o.fontScale ?? 1),
				alignment: String(r.elements.alignment?.value ?? o.alignment ?? "center"),
				color: {
					r: j(r, "colorR", o.color?.r ?? 1),
					g: j(r, "colorG", o.color?.g ?? 1),
					b: j(r, "colorB", o.color?.b ?? 1),
					a: j(r, "colorA", o.color?.a ?? 1)
				}
			});
		}
	}, O(e, "span", { className: "otn-inspector__title" }, r("textStyle")), O(e, "div", { className: "otn-field__row" }, O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("fontName")), O(e, "input", {
		className: "otn-field__input",
		name: "fontName",
		defaultValue: o.fontName ?? "Helvetica-Bold",
		"data-otn-text-field": "fontName"
	})), O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("fontSize")), O(e, "input", {
		className: "otn-field__input",
		name: "fontSize",
		type: "number",
		min: 4,
		max: 400,
		defaultValue: String(o.fontSize ?? 48),
		"data-otn-text-field": "fontSize"
	}))), O(e, "div", { className: "otn-field__row" }, O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("alignment")), O(e, "select", {
		className: "otn-field__input",
		name: "alignment",
		defaultValue: o.alignment ?? "center",
		"data-otn-text-field": "alignment"
	}, [
		"left",
		"center",
		"right"
	].map((t) => O(e, "option", {
		key: t,
		value: t
	}, t)))), O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("textColor")), O(e, "div", { className: "otn-field__row" }, O(e, "input", {
		className: "otn-field__input",
		name: "colorR",
		type: "number",
		min: 0,
		max: 1,
		step: .05,
		defaultValue: String(o.color?.r ?? 1),
		"aria-label": "R"
	}), O(e, "input", {
		className: "otn-field__input",
		name: "colorG",
		type: "number",
		min: 0,
		max: 1,
		step: .05,
		defaultValue: String(o.color?.g ?? 1),
		"aria-label": "G"
	}), O(e, "input", {
		className: "otn-field__input",
		name: "colorB",
		type: "number",
		min: 0,
		max: 1,
		step: .05,
		defaultValue: String(o.color?.b ?? 1),
		"aria-label": "B"
	})))), O(e, "button", {
		type: "submit",
		className: "otn-btn",
		disabled: i,
		"data-otn-action": "text-style-apply"
	}, r("apply"))), O(e, "form", {
		className: "otn-advanced-card",
		"data-otn-advanced-section": "chromaKey",
		onSubmit: (e) => {
			e.preventDefault();
			let r = e.currentTarget;
			n.setChromaKey(t.id, {
				keyColor: {
					r: j(r, "keyR", s?.keyColor?.r ?? 0),
					g: j(r, "keyG", s?.keyColor?.g ?? 1),
					b: j(r, "keyB", s?.keyColor?.b ?? 0)
				},
				similarity: j(r, "similarity", s?.similarity ?? .15),
				smoothness: j(r, "smoothness", s?.smoothness ?? .35),
				spill: j(r, "spill", s?.spill ?? .5)
			});
		}
	}, O(e, "span", { className: "otn-inspector__title" }, r("chromaKey")), O(e, "div", { className: "otn-field__row" }, O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("keyColor")), O(e, "div", { className: "otn-field__row" }, O(e, "input", {
		className: "otn-field__input",
		name: "keyR",
		type: "number",
		min: 0,
		max: 1,
		step: .05,
		defaultValue: String(s?.keyColor?.r ?? 0),
		"aria-label": "R"
	}), O(e, "input", {
		className: "otn-field__input",
		name: "keyG",
		type: "number",
		min: 0,
		max: 1,
		step: .05,
		defaultValue: String(s?.keyColor?.g ?? 1),
		"aria-label": "G"
	}), O(e, "input", {
		className: "otn-field__input",
		name: "keyB",
		type: "number",
		min: 0,
		max: 1,
		step: .05,
		defaultValue: String(s?.keyColor?.b ?? 0),
		"aria-label": "B"
	}))), O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("similarity")), O(e, "input", {
		className: "otn-field__input",
		name: "similarity",
		type: "number",
		min: 0,
		max: 1,
		step: .01,
		defaultValue: String(s?.similarity ?? .15),
		"data-otn-chroma-field": "similarity"
	})), O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("spill")), O(e, "input", {
		className: "otn-field__input",
		name: "spill",
		type: "number",
		min: 0,
		max: 1,
		step: .01,
		defaultValue: String(s?.spill ?? .5),
		"data-otn-chroma-field": "spill"
	}))), O(e, "div", { className: "otn-field__row" }, O(e, "button", {
		type: "submit",
		className: "otn-btn",
		disabled: i,
		"data-otn-action": "chroma-apply"
	}, r("apply")), s === null ? null : O(e, "button", {
		type: "button",
		className: "otn-toggle",
		disabled: i,
		"data-otn-action": "chroma-remove",
		onClick: () => {
			n.setChromaKey(t.id, null);
		}
	}, r("remove")))), O(e, "form", {
		className: "otn-advanced-card",
		"data-otn-advanced-section": "lut",
		onSubmit: (e) => {
			e.preventDefault();
			let i = e.currentTarget, a = String(i.elements.lutId?.value ?? "").trim(), o = String(i.elements.lutName?.value ?? "").trim();
			if (a.length !== 64 || o.length === 0) {
				n.setError(r("lutInvalid"));
				return;
			}
			n.setLut(t.id, {
				id: a,
				name: o,
				intensity: j(i, "lutIntensity", 1)
			});
		}
	}, O(e, "span", { className: "otn-inspector__title" }, r("lut")), O(e, "p", { className: "otn-sheet__hint" }, c === null ? r("noLut") : `${c.name ?? ""} · ${c.intensity ?? ""}`), O(e, "div", { className: "otn-field__row" }, O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("lutId")), O(e, "input", {
		className: "otn-field__input",
		name: "lutId",
		defaultValue: c?.id ?? "",
		"data-otn-lut-field": "id",
		spellCheck: !1
	})), O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("lutIntensity")), O(e, "input", {
		className: "otn-field__input",
		name: "lutIntensity",
		type: "number",
		min: 0,
		max: 1,
		step: .05,
		defaultValue: String(c?.intensity ?? 1),
		"data-otn-lut-field": "intensity"
	}))), O(e, "div", { className: "otn-field__row" }, O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("lutName")), O(e, "input", {
		className: "otn-field__input",
		name: "lutName",
		defaultValue: c?.name ?? "",
		"data-otn-lut-field": "name"
	})), O(e, "button", {
		type: "submit",
		className: "otn-btn",
		disabled: i,
		"data-otn-action": "lut-apply"
	}, r("apply")), c === null ? null : O(e, "button", {
		type: "button",
		className: "otn-toggle",
		disabled: i,
		"data-otn-action": "lut-remove",
		onClick: () => {
			n.setLut(t.id, null);
		}
	}, r("remove")))));
}
var xe = [
	"grayscale",
	"sepia",
	"invert"
], Se = [
	{
		property: "opacity",
		field: "opacityTrack",
		scalar: !0,
		value: (e) => Number(e.opacity ?? 1)
	},
	{
		property: "volume",
		field: "volumeTrack",
		scalar: !0,
		value: (e) => Number(e.volume ?? 1)
	},
	{
		property: "rotation",
		field: "rotationTrack",
		scalar: !0,
		value: (e) => Number(e.transform?.rotation ?? 0)
	},
	{
		property: "position",
		field: "positionTrack",
		scalar: !1
	},
	{
		property: "scale",
		field: "scaleTrack",
		scalar: !1
	},
	{
		property: "crop",
		field: "cropTrack",
		scalar: !1
	}
];
function Ce({ React: e, clip: t, store: n, t: r, disabled: i }) {
	let a = Array.isArray(t.effects) ? t.effects : [];
	function o(e) {
		n.setClipEffects(t.id, e);
	}
	function s(e) {
		a.length >= 8 || o([...a, {
			name: e,
			params: { amount: 1 },
			enabled: !0
		}]);
	}
	function c(e, t) {
		o(a.map((n, r) => r === e ? {
			...n,
			...t
		} : n));
	}
	return O(e, "div", {
		className: "otn-inspector__group",
		"data-otn-effects": ""
	}, O(e, "span", { className: "otn-inspector__title" }, r("effects")), O(e, "div", { className: "otn-field__row" }, xe.map((t) => O(e, "button", {
		key: t,
		type: "button",
		className: "otn-toggle",
		"data-otn-effect-add": t,
		disabled: i || a.length >= 8,
		onClick: () => s(t)
	}, t))), a.length === 0 ? O(e, "p", { className: "otn-sheet__hint" }, r("noEffects")) : null, a.map((t, n) => O(e, "div", {
		key: `${t.name}-${n}`,
		className: "otn-effect-card",
		"data-otn-effect-index": n,
		"data-otn-effect-name": t.name
	}, O(e, "div", { className: "otn-field__row" }, O(e, "strong", { className: "otn-inspector__track-name" }, t.name), O(e, "button", {
		type: "button",
		className: "otn-toggle",
		"aria-pressed": t.enabled !== !1,
		"data-otn-effect-enabled": n,
		onClick: () => c(n, { enabled: t.enabled === !1 })
	}, r("effectEnabled")), O(e, "button", {
		type: "button",
		className: "otn-toggle",
		"data-otn-effect-remove": n,
		onClick: () => o(a.filter((e, t) => t !== n))
	}, r("removeEffect"))), O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("amount")), O(e, "input", {
		className: "otn-field__input",
		type: "number",
		min: 0,
		max: 1,
		step: .01,
		defaultValue: String(t.params?.amount ?? 1),
		"data-otn-effect-amount": n,
		onBlur: (e) => {
			let r = Math.min(1, Math.max(0, Number(e.target.value)));
			Number.isFinite(r) && c(n, { params: {
				...t.params ?? {},
				amount: r
			} });
		}
	})))), O(e, "p", { className: "otn-sheet__hint" }, r("effectsHint")));
}
function we({ React: e, state: t, clip: n, store: r, t: i, disabled: a }) {
	return O(e, "div", {
		className: "otn-inspector__group",
		"data-otn-keyframes": ""
	}, O(e, "span", { className: "otn-inspector__title" }, i("keyframes")), Se.map(({ property: o, field: s, scalar: c, value: l }) => {
		let u = n[s], d = Array.isArray(u?.keyframes) ? u.keyframes : [], f = c && u !== void 0 ? se(u, t.frame) : null;
		return O(e, "div", {
			key: o,
			className: "otn-keyframe-track",
			"data-otn-keyframe-track": o
		}, O(e, "div", { className: "otn-field__row" }, O(e, "strong", { className: "otn-inspector__track-name" }, o), O(e, "span", { className: "otn-sheet__hint" }, `${d.length}`), c ? O(e, "button", {
			type: "button",
			className: "otn-toggle",
			"data-otn-keyframe-add": o,
			disabled: a,
			onClick: () => {
				r.upsertKeyframe(n.id, o, t.frame, Number(l(n)));
			}
		}, i("addKeyframe")) : null), d.length === 0 ? null : O(e, "div", { className: "otn-keyframe-list" }, d.map((t) => O(e, "div", {
			key: `${o}-${t.frame}`,
			className: "otn-keyframe-row",
			"data-otn-keyframe-frame": t.frame
		}, O(e, "span", null, `${i("frame")} ${t.frame}`), O(e, "span", { className: "otn-sheet__hint" }, typeof t.value == "object" ? JSON.stringify(t.value) : String(t.value)), O(e, "button", {
			type: "button",
			className: "otn-toggle",
			disabled: a,
			"data-otn-keyframe-remove": `${o}:${t.frame}`,
			onClick: () => {
				r.removeKeyframe(n.id, o, t.frame);
			}
		}, i("removeKeyframe"))))), f === null ? null : O(e, "span", { className: "otn-sheet__hint" }, `${i("evaluate")} ${t.frame}: ${f.toFixed(3)}`));
	}), O(e, "p", { className: "otn-sheet__hint" }, i("keyframesHint")));
}
function Te(e) {
	let t = e?.shape?.kind;
	return t === "circle" ? "ellipse" : t === "poly" ? "rectangle / poly" : t === "linear" ? "linear" : "mask";
}
function Ee({ React: e, clip: t, store: n, t: r, disabled: i }) {
	let a = Array.isArray(t.masks) ? t.masks : [];
	function o(e) {
		n.setClipMasks(t.id, e);
	}
	function s(e, t) {
		o(a.map((n, r) => r === e ? {
			...n,
			...t
		} : n));
	}
	function c(e) {
		let t = e === "ellipse" ? {
			shape: {
				kind: "circle",
				center: {
					x: .5,
					y: .5
				},
				radius: {
					x: .3,
					y: .3
				}
			},
			feather: 0,
			invert: !1
		} : {
			shape: {
				kind: "poly",
				points: [
					{
						x: .25,
						y: .25
					},
					{
						x: .75,
						y: .25
					},
					{
						x: .75,
						y: .75
					},
					{
						x: .25,
						y: .75
					}
				]
			},
			feather: 0,
			invert: !1
		};
		o([...a, t]);
	}
	return O(e, "div", {
		className: "otn-inspector__group",
		"data-otn-masks": ""
	}, O(e, "span", { className: "otn-inspector__title" }, r("masks")), O(e, "div", { className: "otn-field__row" }, O(e, "button", {
		type: "button",
		className: "otn-toggle",
		disabled: i,
		"data-otn-mask-add": "rect",
		onClick: () => c("rect")
	}, r("addRectMask")), O(e, "button", {
		type: "button",
		className: "otn-toggle",
		disabled: i,
		"data-otn-mask-add": "ellipse",
		onClick: () => c("ellipse")
	}, r("addEllipseMask"))), a.length === 0 ? O(e, "p", { className: "otn-sheet__hint" }, r("noMasks")) : a.map((t, i) => O(e, "div", {
		key: i,
		className: "otn-effect-card",
		"data-otn-mask-index": i
	}, O(e, "div", { className: "otn-field__row" }, O(e, "strong", { className: "otn-inspector__track-name" }, Te(t)), O(e, "button", {
		type: "button",
		className: "otn-toggle",
		"aria-pressed": t.invert === !0,
		"data-otn-mask-invert": i,
		onClick: () => s(i, { invert: t.invert !== !0 })
	}, r("invertMask")), O(e, "button", {
		type: "button",
		className: "otn-toggle",
		"data-otn-mask-remove": i,
		onClick: () => o(a.filter((e, t) => t !== i))
	}, r("removeMask"))), O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("feather")), O(e, "input", {
		className: "otn-field__input",
		type: "number",
		min: 0,
		max: 1,
		step: .01,
		defaultValue: String(t.feather ?? 0),
		"data-otn-mask-feather": i,
		onBlur: (e) => {
			let t = Math.max(0, Number(e.target.value));
			Number.isFinite(t) && s(i, { feather: t });
		}
	})), (() => {
		let a = t.transform ?? {
			offset: {
				x: 0,
				y: 0
			},
			scale: {
				x: 1,
				y: 1
			},
			rotationDegrees: 0
		}, o = (e) => s(i, { transform: {
			...a,
			...e
		} });
		return O(e, "div", {
			className: "otn-mask-advanced",
			"data-otn-mask-transform": i
		}, O(e, "span", { className: "otn-field__label" }, r("maskTransform")), O(e, "div", { className: "otn-field__row" }, O(e, "input", {
			className: "otn-field__input",
			type: "number",
			step: .01,
			defaultValue: String(a.offset?.x ?? 0),
			"aria-label": "offsetX",
			"data-otn-mask-offset-x": i,
			onBlur: (e) => o({ offset: {
				...a.offset ?? {
					x: 0,
					y: 0
				},
				x: Number(e.target.value)
			} })
		}), O(e, "input", {
			className: "otn-field__input",
			type: "number",
			step: .01,
			defaultValue: String(a.offset?.y ?? 0),
			"aria-label": "offsetY",
			"data-otn-mask-offset-y": i,
			onBlur: (e) => o({ offset: {
				...a.offset ?? {
					x: 0,
					y: 0
				},
				y: Number(e.target.value)
			} })
		}), O(e, "input", {
			className: "otn-field__input",
			type: "number",
			step: .01,
			defaultValue: String(a.scale?.x ?? 1),
			"aria-label": "scaleX",
			"data-otn-mask-scale-x": i,
			onBlur: (e) => o({ scale: {
				...a.scale ?? {
					x: 1,
					y: 1
				},
				x: Number(e.target.value)
			} })
		}), O(e, "input", {
			className: "otn-field__input",
			type: "number",
			step: .01,
			defaultValue: String(a.scale?.y ?? 1),
			"aria-label": "scaleY",
			"data-otn-mask-scale-y": i,
			onBlur: (e) => o({ scale: {
				...a.scale ?? {
					x: 1,
					y: 1
				},
				y: Number(e.target.value)
			} })
		}), O(e, "input", {
			className: "otn-field__input",
			type: "number",
			step: 1,
			defaultValue: String(a.rotationDegrees ?? 0),
			"aria-label": "rotation",
			"data-otn-mask-rotation": i,
			onBlur: (e) => o({ rotationDegrees: Number(e.target.value) })
		})), t.shape?.kind === "poly" ? O(e, "div", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("maskPoints")), O(e, "textarea", {
			className: "otn-field__input",
			rows: 2,
			defaultValue: JSON.stringify(t.shape.points ?? []),
			"data-otn-mask-points": i
		}), O(e, "button", {
			type: "button",
			className: "otn-btn",
			"data-otn-mask-points-apply": i,
			onClick: (e) => {
				try {
					let n = JSON.parse(e.currentTarget.previousSibling.value);
					if (!Array.isArray(n) || n.length < 3) throw Error("need 3+ points");
					s(i, { shape: {
						...t.shape,
						points: n
					} });
				} catch {
					n.setError(r("maskPointsInvalid"));
				}
			}
		}, r("apply"))) : null);
	})())), O(e, "p", { className: "otn-sheet__hint" }, r("masksHint")));
}
function De({ React: e, state: t, store: n, t: r }) {
	let i = oe(t.timeline), [a, o] = e.useState(""), [s, c] = e.useState({
		content: "",
		startFrame: 0,
		durationFrames: 60
	}), l = i.find((e) => e.clip.id === a)?.clip ?? null;
	function u(e) {
		o(e.id), c({
			content: typeof e.textContent == "string" ? e.textContent : "",
			startFrame: e.startFrame,
			durationFrames: e.durationFrames
		});
	}
	function d(e) {
		e.preventDefault();
		let t = s.content.trim();
		t.length !== 0 && (n.addCaption({
			content: t,
			startFrame: Number(s.startFrame),
			durationFrames: Number(s.durationFrames)
		}), c({
			content: "",
			startFrame: 0,
			durationFrames: 60
		}));
	}
	function f() {
		l !== null && n.updateCaption(l.id, {
			content: s.content,
			startFrame: Number(s.startFrame),
			durationFrames: Number(s.durationFrames)
		});
	}
	return O(e, "div", {
		className: "otn-overlay",
		"data-otn-panel": "captions"
	}, O(e, "section", {
		className: "otn-sheet",
		"aria-label": r("captions")
	}, O(e, "div", { className: "otn-sheet__header" }, O(e, "h2", { className: "otn-sheet__title" }, r("captions")), k(e, r("close"), () => n.closePanel(), { ariaLabel: r("close") })), O(e, "div", { className: "otn-sheet__body" }, O(e, "div", { className: "otn-sheet__section" }, O(e, "span", { className: "otn-sheet__section-title" }, r("captions")), i.length === 0 ? O(e, "p", { className: "otn-sheet__hint" }, r("captionsEmpty")) : i.map((t) => O(e, "button", {
		key: t.clip.id,
		type: "button",
		className: `otn-toggle${t.clip.id === a ? " otn-toggle--active" : ""}`,
		"data-otn-caption-id": t.clip.id,
		onClick: () => u(t.clip)
	}, `${t.clip.startFrame}+${t.clip.durationFrames} · ${t.clip.textContent ?? ""}`))), O(e, "form", {
		className: "otn-sheet__section",
		onSubmit: d
	}, O(e, "span", { className: "otn-sheet__section-title" }, r("addCaption")), O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("captionText")), O(e, "textarea", {
		className: "otn-field__input",
		rows: 2,
		value: s.content,
		"data-otn-caption-content": "new",
		onChange: (e) => c((t) => ({
			...t,
			content: e.target.value
		}))
	})), O(e, "div", { className: "otn-field__row" }, O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("rangeStart")), O(e, "input", {
		className: "otn-field__input",
		type: "number",
		min: 0,
		value: s.startFrame,
		"data-otn-caption-start": "new",
		onChange: (e) => c((t) => ({
			...t,
			startFrame: e.target.value
		}))
	})), O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("duration")), O(e, "input", {
		className: "otn-field__input",
		type: "number",
		min: 1,
		value: s.durationFrames,
		"data-otn-caption-duration": "new",
		onChange: (e) => c((t) => ({
			...t,
			durationFrames: e.target.value
		}))
	}))), O(e, "div", { className: "otn-field__row" }, O(e, "button", {
		type: "submit",
		className: "otn-btn otn-btn--primary",
		"data-otn-action": "caption-create"
	}, r("addCaption")))), l === null ? null : O(e, "div", {
		className: "otn-sheet__section",
		"data-otn-caption-edit": l.id
	}, O(e, "span", { className: "otn-sheet__section-title" }, `${r("saveCaption")} · ${l.captionGroupId}`), O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("captionText")), O(e, "textarea", {
		className: "otn-field__input",
		rows: 2,
		value: s.content,
		"data-otn-caption-content": "selected",
		onChange: (e) => c((t) => ({
			...t,
			content: e.target.value
		}))
	})), O(e, "div", { className: "otn-field__row" }, O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("rangeStart")), O(e, "input", {
		className: "otn-field__input",
		type: "number",
		min: 0,
		value: s.startFrame,
		"data-otn-caption-start": "selected",
		onChange: (e) => c((t) => ({
			...t,
			startFrame: e.target.value
		}))
	})), O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("duration")), O(e, "input", {
		className: "otn-field__input",
		type: "number",
		min: 1,
		value: s.durationFrames,
		"data-otn-caption-duration": "selected",
		onChange: (e) => c((t) => ({
			...t,
			durationFrames: e.target.value
		}))
	}))), O(e, "div", { className: "otn-field__row" }, O(e, "button", {
		type: "button",
		className: "otn-btn otn-btn--primary",
		"data-otn-action": "caption-save",
		onClick: f
	}, r("saveCaption")))))));
}
var Oe = [
	"h264",
	"h265",
	"prores",
	"prores4444"
], ke = [
	"720p",
	"1080p",
	"4k"
];
function Ae({ React: e, state: t, store: n, t: r }) {
	let [i, a] = e.useState({
		outPath: "/tmp/opentake-export.mp4",
		codec: "h264",
		quality: "1080p",
		bitDepth: 8,
		rangeStartFrame: 0,
		rangeEndFrame: "",
		duckMusic: !1,
		hdr10: !1
	}), o = t.exportState;
	function s(e, t) {
		a((n) => ({
			...n,
			[e]: t
		}));
	}
	function c(e) {
		e.preventDefault(), !o.active && n.exportVideo({
			outPath: i.outPath.trim(),
			codec: i.codec,
			quality: i.quality,
			bitDepth: i.bitDepth === 10 ? 10 : 8,
			rangeStartFrame: i.rangeStartFrame === "" ? null : Number(i.rangeStartFrame),
			rangeEndFrame: i.rangeEndFrame === "" ? null : Number(i.rangeEndFrame),
			duckMusic: i.duckMusic,
			hdr10: i.hdr10
		});
	}
	let l = o.total > 0 ? Math.min(100, Math.round(o.done / o.total * 100)) : 0;
	return O(e, "div", {
		className: "otn-overlay",
		"data-otn-panel": "export"
	}, O(e, "form", {
		className: "otn-sheet",
		onSubmit: c,
		"aria-label": r("exportTitle")
	}, O(e, "div", { className: "otn-sheet__header" }, O(e, "h2", { className: "otn-sheet__title" }, r("exportTitle")), k(e, r("close"), () => n.closePanel(), { ariaLabel: r("close") })), O(e, "div", { className: "otn-sheet__body" }, O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("outputPath")), O(e, "input", {
		className: "otn-field__input",
		value: i.outPath,
		"data-otn-export-field": "outPath",
		onChange: (e) => s("outPath", e.target.value),
		spellCheck: !1
	})), O(e, "div", { className: "otn-field__row" }, O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("codec")), O(e, "select", {
		className: "otn-field__input",
		value: i.codec,
		"data-otn-export-field": "codec",
		onChange: (e) => s("codec", e.target.value)
	}, Oe.map((t) => O(e, "option", {
		key: t,
		value: t
	}, t)))), O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("quality")), O(e, "select", {
		className: "otn-field__input",
		value: i.quality,
		"data-otn-export-field": "quality",
		onChange: (e) => s("quality", e.target.value)
	}, ke.map((t) => O(e, "option", {
		key: t,
		value: t
	}, t)))), O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, r("bitDepth")), O(e, "select", {
		className: "otn-field__input",
		value: i.bitDepth,
		"data-otn-export-field": "bitDepth",
		onChange: (e) => s("bitDepth", Number(e.target.value))
	}, O(e, "option", { value: 8 }, "8-bit"), O(e, "option", { value: 10 }, "10-bit")))), O(e, "div", { className: "otn-field__row" }, O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, `${r("range")} · ${r("rangeStart")}`), O(e, "input", {
		className: "otn-field__input",
		type: "number",
		min: 0,
		value: i.rangeStartFrame,
		"data-otn-export-field": "rangeStartFrame",
		onChange: (e) => s("rangeStartFrame", e.target.value)
	})), O(e, "label", { className: "otn-field" }, O(e, "span", { className: "otn-field__label" }, `${r("range")} · ${r("rangeEnd")}`), O(e, "input", {
		className: "otn-field__input",
		type: "number",
		min: 0,
		value: i.rangeEndFrame,
		placeholder: r("notAvailable"),
		"data-otn-export-field": "rangeEndFrame",
		onChange: (e) => s("rangeEndFrame", e.target.value)
	}))), O(e, "div", { className: "otn-field__row" }, O(e, "button", {
		type: "button",
		className: "otn-toggle",
		"aria-pressed": i.duckMusic,
		"data-otn-export-field": "duckMusic",
		onClick: () => s("duckMusic", !i.duckMusic)
	}, r("duckMusic")), O(e, "button", {
		type: "button",
		className: "otn-toggle",
		"aria-pressed": i.hdr10,
		"data-otn-export-field": "hdr10",
		onClick: () => s("hdr10", !i.hdr10)
	}, r("hdr10"))), O(e, "p", { className: "otn-sheet__hint" }, r("exportHint")), O(e, "div", { className: "otn-field__row" }, O(e, "button", {
		type: "submit",
		className: "otn-btn otn-btn--primary",
		"data-otn-action": "export-submit",
		disabled: o.active
	}, o.active ? r("exporting") : r("exportNow")), o.active ? k(e, r("cancel"), () => {
		n.cancelExport();
	}) : null), O(e, "div", {
		className: "otn-field",
		"data-otn-export-status": o.phase,
		role: "status"
	}, O(e, "span", { className: "otn-field__label" }, o.phase === "error" ? r("exportFailed") : o.phase === "complete" ? r("exportComplete") : o.active ? r("exporting") : r("exportIdle")), o.active ? O(e, "div", { className: "otn-progress-bar" }, O(e, "div", {
		className: "otn-progress-bar__fill",
		style: { inlineSize: `${l}%` }
	})) : null, o.active ? O(e, "span", { className: "otn-sheet__hint" }, `${o.done} / ${o.total || "?"}`) : null, o.error === null ? null : O(e, "span", { className: "otn-sheet__hint" }, o.error), o.summary === null ? null : O(e, "span", { className: "otn-sheet__hint" }, JSON.stringify(o.summary).slice(0, 500))))));
}
function je({ React: e, state: t, store: n, t: r }) {
	e.useEffect(() => {
		n.refreshSettings();
	}, []);
	let i = t.settings, a = i?.storage, o = Array.isArray(a?.categories) ? a.categories : [], s = i?.search ?? null, c = i?.transcribe ?? null;
	return O(e, "div", {
		className: "otn-overlay",
		"data-otn-panel": "settings"
	}, O(e, "section", {
		className: "otn-sheet",
		"aria-label": r("settingsTitle")
	}, O(e, "div", { className: "otn-sheet__header" }, O(e, "h2", { className: "otn-sheet__title" }, r("settingsTitle")), k(e, r("close"), () => n.closePanel(), { ariaLabel: r("close") })), O(e, "div", { className: "otn-sheet__body" }, O(e, "p", { className: "otn-sheet__hint" }, r("settingsHint")), O(e, "div", { className: "otn-sheet__section" }, O(e, "span", { className: "otn-sheet__section-title" }, r("storage")), O(e, "div", { className: "otn-storage-row" }, O(e, "span", { className: "otn-storage-row__name" }, r("total")), O(e, "span", null, `${Math.round(Number(a?.totalBytes ?? 0) / 1024)} KB`)), o.map((i) => O(e, "div", {
		key: i.id,
		className: "otn-storage-row"
	}, O(e, "span", { className: "otn-storage-row__name" }, String(i.id)), O(e, "span", null, `${Math.round(Number(i.bytes ?? 0) / 1024)} KB`), [
		"thumbnails",
		"other",
		"searchIndex"
	].includes(i.id) ? k(e, r("clearCache"), () => {
		n.clearStorage([i.id]);
	}, { disabled: t.settingsLoading }) : null))), O(e, "div", { className: "otn-sheet__section" }, O(e, "span", { className: "otn-sheet__section-title" }, r("modelStatus")), O(e, "div", { className: "otn-kv" }, O(e, "span", null, r("searchModel")), O(e, "span", { className: "otn-kv__value" }, s === null ? r("notAvailable") : `${s.visualAvailable === !0 ? "ready" : "missing"}${s.model ? ` · ${s.model}` : ""}`), O(e, "span", null, r("transcribeModel")), O(e, "span", { className: "otn-kv__value" }, c === null ? r("notAvailable") : `${c.installed === !0 ? "ready" : "not configured"}${c.model ? ` · ${c.model}` : ""}`), O(e, "span", null, r("searchIndex")), O(e, "span", { className: "otn-kv__value" }, i?.searchIndex === null || i?.searchIndex === void 0 ? r("notAvailable") : JSON.stringify(i.searchIndex).slice(0, 180)))), i?.error !== null && i?.error !== void 0 ? O(e, "p", { className: "otn-error__message" }, i.error) : null, O(e, "div", { className: "otn-field__row" }, k(e, r("refresh"), () => {
		n.refreshSettings();
	}, { disabled: t.settingsLoading }), t.settingsLoading ? O(e, "span", {
		className: "otn-progress",
		role: "status"
	}, r("loading")) : null))));
}
function Me(e, { state: t, store: n, client: r, t: i }) {
	return O(e, "div", { className: "otn-body" }, pe(e, {
		state: t,
		client: r,
		t: i,
		store: n
	}), O(e, "div", { className: "otn-main" }, me(e, {
		state: t,
		client: r,
		store: n,
		t: i
	}), ge(e, {
		state: t,
		store: n,
		t: i
	})), O(e, _e, {
		React: e,
		state: t,
		store: n,
		t: i
	}));
}
function Ne({ React: e, store: t, client: n, theme: r = "system" }) {
	if (e === null || typeof e.createElement != "function") throw TypeError("React is required");
	if (typeof n != "object" || !n) throw TypeError("client is required");
	let i = le(e, t), a = S(i.locale).t, o = r === "light" || r === "dark" ? r : i.theme === "light" || i.theme === "dark" ? i.theme : "system", s = i.loading || i.busy, c = e.useRef(null), [l, u] = e.useState(!1);
	function d(e) {
		let n = e.target, r = typeof n?.tagName == "string" ? n.tagName.toLowerCase() : "";
		if (r === "input" || r === "textarea" || r === "select" || n?.isContentEditable === !0) return;
		let a = e.metaKey || e.ctrlKey, o = e.key;
		if (o === " ") {
			e.preventDefault(), i.playback.active && !i.playback.paused ? t.pause() : t.play();
			return;
		}
		if (o === "ArrowLeft" || o === "ArrowRight") {
			e.preventDefault();
			let n = o === "ArrowLeft" ? -1 : 1;
			e.shiftKey ? t.moveSelected(n) : t.seekTo(i.frame + n);
			return;
		}
		if (a && (o === "z" || o === "Z")) {
			e.preventDefault(), e.shiftKey ? t.redo() : t.undo();
			return;
		}
		if (a && (o === "y" || o === "Y")) {
			e.preventDefault(), t.redo();
			return;
		}
		if (o === "Delete" || o === "Backspace") {
			e.preventDefault(), t.removeSelected();
			return;
		}
		if (a && (o === "s" || o === "S")) {
			e.preventDefault(), t.saveProject();
			return;
		}
		if (a && (o === "e" || o === "E")) {
			e.preventDefault(), t.openPanel("export");
			return;
		}
		if (o === "?" || o === "/" && e.shiftKey) {
			e.preventDefault(), u((e) => !e);
			return;
		}
		o === "Escape" && (u(!1), i.panel !== "editor" && t.closePanel());
	}
	return O(e, "div", {
		ref: c,
		tabIndex: 0,
		onKeyDown: d,
		onPointerDown: (e) => {
			e.currentTarget === e.target && e.currentTarget.focus();
		},
		className: "otn-root",
		"data-theme": o,
		"data-otn-panel": i.panel,
		lang: i.locale
	}, O(e, "header", { className: "otn-header" }, O(e, "div", { className: "otn-brand" }, O(e, "span", { className: "otn-brand__name" }, a("appName")), O(e, "span", { className: "otn-brand__note" }, a("nativePreview"))), ue(e, i, a), O(e, "span", {
		className: "otn-project-path",
		title: i.projectPath ?? ""
	}, i.projectPath ?? a("noProject")), O(e, "span", { className: "otn-spacer" }), O(e, "div", { className: "otn-actions" }, i.view === "editor" ? k(e, a("home"), () => t.setView("home")) : null, i.view === "editor" ? O(e, "button", {
		type: "button",
		className: "otn-btn",
		"data-otn-action": "open-inspector",
		onClick: () => {
			t.setView("editor"), t.closePanel();
		}
	}, a("inspector")) : null, O(e, "button", {
		type: "button",
		className: "otn-btn",
		"data-otn-action": "open-captions",
		"aria-pressed": i.panel === "captions",
		onClick: () => t.openPanel(i.panel === "captions" ? "editor" : "captions")
	}, a("captions")), O(e, "button", {
		type: "button",
		className: "otn-btn",
		"data-otn-action": "open-export",
		"aria-pressed": i.panel === "export",
		onClick: () => t.openPanel(i.panel === "export" ? "editor" : "export")
	}, a("export")), O(e, "button", {
		type: "button",
		className: "otn-btn",
		"data-otn-action": "open-settings",
		"aria-pressed": i.panel === "settings",
		onClick: () => t.openPanel(i.panel === "settings" ? "editor" : "settings")
	}, a("settings")), O(e, "button", {
		type: "button",
		className: "otn-btn",
		"data-otn-action": "open-shortcuts",
		"aria-pressed": l,
		title: a("shortcuts"),
		onClick: () => u((e) => !e)
	}, "?"), i.view === "editor" ? k(e, a("saveProject"), () => {
		t.saveProject();
	}, { disabled: s }) : null, k(e, a("refresh"), () => {
		t.refresh();
	}, { disabled: s }), s ? O(e, "span", {
		className: "otn-progress",
		role: "status"
	}, a("busy")) : null)), de(e, i, t, a), i.view === "home" ? O(e, fe, {
		React: e,
		state: i,
		store: t,
		client: n,
		t: a
	}) : Me(e, {
		state: i,
		store: t,
		client: n,
		t: a
	}), i.panel === "captions" ? O(e, De, {
		React: e,
		state: i,
		store: t,
		t: a
	}) : null, i.panel === "export" ? O(e, Ae, {
		React: e,
		state: i,
		store: t,
		t: a
	}) : null, i.panel === "settings" ? O(e, je, {
		React: e,
		state: i,
		store: t,
		t: a
	}) : null, l ? O(e, "div", {
		className: "otn-overlay",
		"data-otn-panel": "shortcuts"
	}, O(e, "section", {
		className: "otn-sheet",
		"aria-label": a("shortcutsHelp")
	}, O(e, "div", { className: "otn-sheet__header" }, O(e, "h2", { className: "otn-sheet__title" }, a("shortcutsHelp")), k(e, a("close"), () => u(!1), { ariaLabel: a("close") })), O(e, "div", { className: "otn-sheet__body" }, O(e, "ul", { className: "otn-shortcut-list" }, [
		["shortcutPlay"],
		["shortcutSeek"],
		["shortcutNudge"],
		["shortcutUndo"],
		["shortcutRedo"],
		["shortcutDelete"],
		["shortcutSave"],
		["shortcutExport"],
		["shortcutHelp"]
	].map(([t]) => O(e, "li", { key: t }, O(e, "span", null, a(t)))))))) : null, O(e, "footer", { className: "otn-status" }, O(e, "span", null, `${a("projectVersion", { version: i.timeline?.version ?? 0 })}`), O(e, "span", { className: "otn-spacer" }), O(e, "span", null, `${a("media")}: ${i.media.length}`), O(e, "span", null, `${a("timeline")}: ${ie(i.timeline)}`)));
}
//#endregion
//#region web/src/native/styles.js
var Pe = "\n:host {\n  all: initial;\n  display: block;\n  box-sizing: border-box;\n  height: 100%;\n  min-height: 0;\n  color-scheme: dark;\n  font-family: \"Inter\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif;\n  -webkit-font-smoothing: antialiased;\n}\n*, *::before, *::after { box-sizing: border-box; }\n.otn-root {\n  position: relative;\n  --otn-bg: var(--dsw-alias-bg-base, #0f1115);\n  --otn-panel: var(--dsw-alias-bg-elevated, #171a21);\n  --otn-panel-2: var(--dsw-alias-bg-subtle, #1e222b);\n  --otn-text: var(--dsw-alias-text-primary, #f4f5f7);\n  --otn-muted: var(--dsw-alias-text-secondary, #a6acb8);\n  --otn-border: var(--dsw-alias-border-default, rgba(255, 255, 255, .13));\n  --otn-accent: var(--dsw-alias-accent-primary, #7c5cff);\n  --otn-accent-soft: color-mix(in srgb, var(--otn-accent) 20%, transparent);\n  --otn-danger: var(--dsw-alias-status-error, #ff6b6b);\n  --otn-radius: 10px;\n  display: flex;\n  flex-direction: column;\n  inline-size: 100%;\n  block-size: 100%;\n  min-block-size: 0;\n  overflow: hidden;\n  background: var(--otn-bg);\n  color: var(--otn-text);\n  font-size: 13px;\n  line-height: 1.35;\n}\n.otn-root[data-theme=\"light\"] {\n  color-scheme: light;\n  --otn-bg: var(--dsw-alias-bg-base, #f7f7f8);\n  --otn-panel: var(--dsw-alias-bg-elevated, #ffffff);\n  --otn-panel-2: var(--dsw-alias-bg-subtle, #eef0f3);\n  --otn-text: var(--dsw-alias-text-primary, #171a20);\n  --otn-muted: var(--dsw-alias-text-secondary, #5d6470);\n  --otn-border: var(--dsw-alias-border-default, rgba(20, 24, 32, .16));\n}\n.otn-root[data-theme=\"dark\"] { color-scheme: dark; }\n.otn-header {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  flex: 0 0 auto;\n  min-block-size: 44px;\n  padding: 0 14px;\n  border-block-end: 1px solid var(--otn-border);\n  background: var(--otn-panel);\n}\n.otn-brand { display: flex; align-items: baseline; gap: 8px; min-inline-size: 0; }\n.otn-brand__name { font-weight: 700; letter-spacing: -.02em; font-size: 14px; }\n.otn-brand__note { color: var(--otn-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.otn-spacer { flex: 1 1 auto; }\n.otn-project-path {\n  max-inline-size: 34%;\n  color: var(--otn-muted);\n  font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.otn-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }\n.otn-btn {\n  appearance: none;\n  border: 1px solid var(--otn-border);\n  border-radius: 7px;\n  background: var(--otn-panel-2);\n  color: var(--otn-text);\n  font: inherit;\n  font-size: 12px;\n  padding: 5px 9px;\n  cursor: pointer;\n  min-block-size: 28px;\n}\n.otn-btn:hover:not(:disabled) { border-color: var(--otn-accent); }\n.otn-btn:focus-visible { outline: 2px solid var(--otn-accent); outline-offset: 1px; }\n.otn-btn:disabled { opacity: .5; cursor: default; }\n.otn-btn--primary { background: var(--otn-accent); border-color: var(--otn-accent); color: #fff; }\n.otn-btn--icon { inline-size: 28px; padding: 4px; display: inline-grid; place-items: center; }\n.otn-badge {\n  display: inline-flex;\n  gap: 5px;\n  align-items: center;\n  border: 1px solid var(--otn-border);\n  border-radius: 999px;\n  padding: 3px 8px;\n  color: var(--otn-muted);\n  font-size: 11px;\n  white-space: nowrap;\n}\n.otn-dot { inline-size: 6px; block-size: 6px; border-radius: 50%; background: var(--otn-accent); }\n.otn-dot--down { background: var(--otn-danger); }\n.otn-body { display: flex; flex: 1 1 auto; min-block-size: 0; }\n.otn-main { display: flex; flex: 1 1 auto; flex-direction: column; min-inline-size: 0; min-block-size: 0; }\n.otn-media {\n  inline-size: clamp(180px, 22%, 270px);\n  flex: 0 0 auto;\n  border-inline-end: 1px solid var(--otn-border);\n  background: var(--otn-panel);\n  min-block-size: 0;\n  display: flex;\n  flex-direction: column;\n}\n.otn-panel-title {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n  flex: 0 0 auto;\n  padding: 10px 12px;\n  border-block-end: 1px solid var(--otn-border);\n  color: var(--otn-muted);\n  font-size: 11px;\n  font-weight: 600;\n  letter-spacing: .06em;\n  text-transform: uppercase;\n}\n.otn-media-list { list-style: none; margin: 0; padding: 8px; overflow: auto; display: grid; gap: 6px; min-block-size: 0; }\n.otn-media-card {\n  appearance: none;\n  inline-size: 100%;\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 6px;\n  border: 1px solid transparent;\n  border-radius: 8px;\n  background: var(--otn-panel-2);\n  color: inherit;\n  font: inherit;\n  text-align: start;\n  cursor: pointer;\n}\n.otn-media-card:hover { border-color: var(--otn-border); }\n.otn-media-card--selected { border-color: var(--otn-accent); background: var(--otn-accent-soft); }\n.otn-media-card:focus-visible { outline: 2px solid var(--otn-accent); outline-offset: 1px; }\n.otn-media-thumb {\n  inline-size: 42px;\n  block-size: 30px;\n  border-radius: 5px;\n  background: var(--otn-bg);\n  object-fit: cover;\n  flex: 0 0 auto;\n}\n.otn-media-thumb--empty { display: grid; place-items: center; color: var(--otn-muted); font-size: 10px; }\n.otn-media-copy { min-inline-size: 0; display: grid; gap: 2px; }\n.otn-media-name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; }\n.otn-media-meta { color: var(--otn-muted); font-size: 10px; }\n.otn-empty { color: var(--otn-muted); font-size: 12px; padding: 16px; }\n.otn-preview {\n  flex: 1 1 auto;\n  min-block-size: 0;\n  display: flex;\n  flex-direction: column;\n  background: var(--otn-bg);\n}\n.otn-preview-stage {\n  flex: 1 1 auto;\n  min-block-size: 0;\n  display: grid;\n  place-items: center;\n  padding: 14px;\n  overflow: hidden;\n  background: radial-gradient(circle at 50% 40%, var(--otn-panel-2), var(--otn-bg) 70%);\n}\n.otn-preview-image {\n  display: block;\n  max-inline-size: 100%;\n  max-block-size: 100%;\n  inline-size: auto;\n  block-size: auto;\n  border-radius: 4px;\n  background: #000;\n  box-shadow: 0 8px 28px rgba(0, 0, 0, .35);\n}\n.otn-preview-placeholder {\n  display: grid;\n  place-items: center;\n  inline-size: min(100%, 480px);\n  aspect-ratio: 16 / 9;\n  border: 1px dashed var(--otn-border);\n  border-radius: var(--otn-radius);\n  color: var(--otn-muted);\n  font-size: 12px;\n}\n.otn-transport {\n  flex: 0 0 auto;\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 7px 12px;\n  border-block-start: 1px solid var(--otn-border);\n  background: var(--otn-panel);\n}\n.otn-scrub { flex: 1 1 auto; accent-color: var(--otn-accent); min-inline-size: 60px; }\n.otn-frame-readout { color: var(--otn-muted); font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }\n.otn-media-import { display: flex; gap: 6px; padding: 8px; border-block-end: 1px solid var(--otn-border); }\n.otn-media-import .otn-input { flex: 1 1 auto; min-inline-size: 0; min-block-size: 28px; }\n.otn-file-picker { max-inline-size: 100%; color: var(--otn-muted); font-size: 10px; }\n.otn-file-picker::file-selector-button { margin-inline-end: 6px; border: 1px solid var(--otn-border); border-radius: 5px; background: var(--otn-panel-2); color: var(--otn-text); font-size: 10px; padding: 3px 6px; }\n.otn-effect-card, .otn-advanced-card { display: grid; gap: 6px; padding: 7px; border: 1px solid var(--otn-border); border-radius: 7px; background: var(--otn-panel-2); }\n.otn-advanced-card .otn-field__row { flex-wrap: wrap; }\n.otn-mask-advanced { display: grid; gap: 4px; padding-block-start: 4px; }\n.otn-shortcut-list { display: grid; gap: 5px; margin: 0; padding: 0; list-style: none; font-size: 12px; }\n.otn-shortcut-list li { display: flex; gap: 8px; color: var(--otn-muted); }\n.otn-shortcut-list li span:last-child { color: var(--otn-text); }\n.otn-keyframe-track { display: grid; gap: 4px; padding-block-start: 6px; border-block-start: 1px solid var(--otn-border); }\n.otn-keyframe-track:first-of-type { border-block-start: 0; padding-block-start: 0; }\n.otn-keyframe-list { display: grid; gap: 3px; }\n.otn-keyframe-row { display: flex; align-items: center; gap: 6px; font-size: 11px; }\n.otn-keyframe-row > span:first-child { min-inline-size: 62px; color: var(--otn-muted); }\n.otn-keyframe-row > button { margin-inline-start: auto; }\n.otn-toggle--active { border-color: var(--otn-accent); background: var(--otn-accent-soft); }\n.otn-inspector {\n  inline-size: clamp(220px, 24%, 300px);\n  flex: 0 0 auto;\n  border-inline-start: 1px solid var(--otn-border);\n  background: var(--otn-panel);\n  min-block-size: 0;\n  overflow: auto;\n  padding-block-end: 10px;\n}\n.otn-inspector .otn-panel-title { border-block-end: 1px solid var(--otn-border); }\n.otn-inspector__body { display: grid; gap: 12px; padding: 10px 12px; }\n.otn-inspector__tabs { display: flex; flex-wrap: wrap; gap: 4px; padding-block-end: 4px; border-block-end: 1px solid var(--otn-border); }\n.otn-inspector__tab { appearance: none; border: 1px solid var(--otn-border); border-radius: 999px; background: transparent; color: var(--otn-muted); font: inherit; font-size: 10px; padding: 3px 7px; cursor: pointer; }\n.otn-inspector__tab--active { border-color: var(--otn-accent); background: var(--otn-accent-soft); color: var(--otn-text); }\n.otn-inspector__tab:focus-visible { outline: 2px solid var(--otn-accent); outline-offset: 1px; }\n.otn-field { display: grid; gap: 4px; }\n.otn-field__label { color: var(--otn-muted); font-size: 10px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }\n.otn-field__input {\n  inline-size: 100%;\n  min-block-size: 28px;\n  border: 1px solid var(--otn-border);\n  border-radius: 6px;\n  background: var(--otn-bg);\n  color: var(--otn-text);\n  font: inherit;\n  font-size: 12px;\n  padding: 5px 7px;\n}\n.otn-field__input:focus-visible { outline: 2px solid var(--otn-accent); outline-offset: 1px; }\n.otn-field__row { display: flex; gap: 6px; align-items: center; }\n.otn-field__row .otn-field__input { min-inline-size: 0; }\n.otn-toggle {\n  appearance: none;\n  border: 1px solid var(--otn-border);\n  border-radius: 6px;\n  background: var(--otn-panel-2);\n  color: var(--otn-text);\n  font: inherit;\n  font-size: 11px;\n  padding: 4px 7px;\n  cursor: pointer;\n}\n.otn-toggle[aria-pressed=\"true\"] { border-color: var(--otn-accent); background: var(--otn-accent-soft); }\n.otn-toggle:focus-visible { outline: 2px solid var(--otn-accent); outline-offset: 1px; }\n.otn-inspector__group { display: grid; gap: 7px; padding-block-start: 10px; border-block-start: 1px solid var(--otn-border); }\n.otn-inspector__group:first-child { border-block-start: 0; padding-block-start: 0; }\n.otn-inspector__title { color: var(--otn-muted); font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }\n.otn-inspector__track-name { font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }\n.otn-overlay {\n  position: absolute;\n  inset: 0;\n  z-index: 8;\n  display: flex;\n  justify-content: flex-end;\n  background: rgba(0, 0, 0, .4);\n  padding: 12px;\n}\n.otn-sheet {\n  inline-size: min(480px, 100%);\n  block-size: 100%;\n  overflow: auto;\n  border: 1px solid var(--otn-border);\n  border-radius: var(--otn-radius);\n  background: var(--otn-panel);\n  box-shadow: 0 18px 60px rgba(0, 0, 0, .4);\n}\n.otn-sheet__header { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-block-end: 1px solid var(--otn-border); }\n.otn-sheet__title { flex: 1 1 auto; margin: 0; font-size: 14px; }\n.otn-sheet__body { display: grid; gap: 12px; padding: 14px; }\n.otn-sheet__section { display: grid; gap: 8px; }\n.otn-sheet__section-title { color: var(--otn-muted); font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }\n.otn-sheet__row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }\n.otn-sheet__hint { color: var(--otn-muted); font-size: 11px; margin: 0; }\n.otn-progress-bar { inline-size: 100%; block-size: 5px; border-radius: 999px; background: var(--otn-panel-2); overflow: hidden; }\n.otn-progress-bar__fill { block-size: 100%; background: var(--otn-accent); transition: inline-size .2s ease; }\n.otn-storage-row { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--otn-muted); }\n.otn-storage-row__name { flex: 1 1 auto; color: var(--otn-text); }\n.otn-status-ok { color: var(--otn-accent); }\n.otn-status-bad { color: var(--otn-danger); }\n.otn-timeline {\n  flex: 0 0 38%;\n  min-block-size: 150px;\n  display: flex;\n  flex-direction: column;\n  border-block-start: 1px solid var(--otn-border);\n  background: var(--otn-panel);\n}\n.otn-timeline-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 10px; }\n.otn-timeline-body { overflow: auto; padding: 0 10px 10px; min-block-size: 0; }\n.otn-ruler {\n  position: relative;\n  block-size: 18px;\n  margin-inline-start: 72px;\n  border-block-end: 1px solid var(--otn-border);\n  color: var(--otn-muted);\n  font: 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace;\n}\n.otn-ruler-tick { position: absolute; inset-block-end: 0; inline-size: 1px; block-size: 6px; background: var(--otn-border); }\n.otn-ruler-label { position: absolute; inset-block-start: 2px; transform: translateX(-50%); white-space: nowrap; }\n.otn-track-row { display: flex; align-items: stretch; min-block-size: 34px; border-block-end: 1px solid var(--otn-border); }\n.otn-track-head {\n  inline-size: 72px;\n  flex: 0 0 72px;\n  display: flex;\n  align-items: center;\n  gap: 5px;\n  padding-inline-end: 6px;\n  color: var(--otn-muted);\n  font-size: 10px;\n  white-space: nowrap;\n  overflow: hidden;\n}\n.otn-track-lane { position: relative; flex: 1 1 auto; min-inline-size: 0; margin-block: 4px; border-radius: 4px; background: var(--otn-panel-2); }\n.otn-clip {\n  position: absolute;\n  inset-block: 3px;\n  min-inline-size: 8px;\n  border: 1px solid color-mix(in srgb, var(--otn-accent) 55%, var(--otn-border));\n  border-radius: 4px;\n  background: color-mix(in srgb, var(--otn-accent) 24%, var(--otn-panel-2));\n  color: var(--otn-text);\n  font: 10px/1.2 inherit;\n  padding: 2px 5px;\n  overflow: hidden;\n  white-space: nowrap;\n  text-overflow: ellipsis;\n  text-align: start;\n  cursor: pointer;\n}\n.otn-clip--selected { outline: 2px solid var(--otn-accent); outline-offset: -1px; background: color-mix(in srgb, var(--otn-accent) 38%, var(--otn-panel-2)); }\n.otn-clip:focus-visible { outline: 2px solid var(--otn-accent); outline-offset: 1px; }\n.otn-status {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 6px 12px;\n  border-block-start: 1px solid var(--otn-border);\n  color: var(--otn-muted);\n  font-size: 11px;\n  flex: 0 0 auto;\n}\n.otn-error {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  margin: 8px 12px 0;\n  padding: 7px 9px;\n  border: 1px solid color-mix(in srgb, var(--otn-danger) 55%, var(--otn-border));\n  border-radius: 7px;\n  background: color-mix(in srgb, var(--otn-danger) 12%, transparent);\n  color: var(--otn-text);\n  font-size: 12px;\n}\n.otn-error__message { flex: 1 1 auto; overflow-wrap: anywhere; }\n.otn-home {\n  flex: 1 1 auto;\n  min-block-size: 0;\n  overflow: auto;\n  display: grid;\n  align-content: start;\n  gap: 14px;\n  padding: clamp(18px, 4vw, 44px);\n  max-inline-size: 900px;\n  inline-size: 100%;\n  margin-inline: auto;\n}\n.otn-home__title { margin: 0; font-size: clamp(24px, 4vw, 38px); line-height: 1.05; letter-spacing: -.04em; }\n.otn-home__subtitle { margin: 0; color: var(--otn-muted); max-inline-size: 66ch; }\n.otn-card { border: 1px solid var(--otn-border); border-radius: var(--otn-radius); background: var(--otn-panel); padding: 14px; }\n.otn-home__row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }\n.otn-input {\n  flex: 1 1 260px;\n  min-inline-size: 160px;\n  border: 1px solid var(--otn-border);\n  border-radius: 7px;\n  background: var(--otn-bg);\n  color: var(--otn-text);\n  font: inherit;\n  font-size: 12px;\n  padding: 6px 8px;\n  min-block-size: 30px;\n}\n.otn-input:focus-visible { outline: 2px solid var(--otn-accent); outline-offset: 1px; }\n.otn-kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; color: var(--otn-muted); font-size: 12px; }\n.otn-kv__value { color: var(--otn-text); overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }\n.otn-hint { color: var(--otn-muted); font-size: 11px; margin: 0; }\n.otn-progress { color: var(--otn-muted); font-size: 11px; }\n@media (max-width: 900px) {\n  .otn-inspector { inline-size: 220px; }\n}\n@media (max-width: 720px) {\n  .otn-media { inline-size: 170px; }\n  .otn-inspector { display: none; }\n  .otn-brand__note, .otn-project-path { display: none; }\n  .otn-timeline { flex-basis: 42%; }\n  .otn-home { padding: 16px; }\n}\n@media (prefers-reduced-motion: reduce) {\n  .otn-root *, .otn-root *::before, .otn-root *::after { transition: none !important; animation: none !important; }\n}\n";
//#endregion
//#region web/src/native/mount.js
function Fe(e) {
	if (typeof e != "object" || !e || typeof e.createRoot != "function") throw TypeError("ReactDOM.createRoot is required");
}
function Ie({ host: e, React: t, ReactDOM: n, client: r, locale: i = "en", theme: a = "system", pollIntervalMs: o = 0, autoInitialize: s = !0, timers: c = void 0, onReady: l = void 0 } = {}) {
	if (typeof e != "object" || !e || typeof e.attachShadow != "function") throw TypeError("a host element with attachShadow is required");
	if (typeof t != "object" || !t || typeof t.createElement != "function") throw TypeError("React with createElement is required");
	if (typeof r != "object" || !r || typeof r.timeline != "function") throw TypeError("engine client is required");
	Fe(n);
	let u = e.ownerDocument;
	if (u === null || typeof u.createElement != "function") throw TypeError("host.ownerDocument.createElement is required");
	let d = e.shadowRoot ?? e.attachShadow({ mode: "open" });
	if (d === null || typeof d.appendChild != "function") throw TypeError("open ShadowRoot could not be created");
	for (; d.firstChild !== null && d.firstChild !== void 0;) d.removeChild(d.firstChild);
	let f = u.createElement("style");
	f.textContent = Pe, f.setAttribute?.("data-otn-styles", ""), d.appendChild(f);
	let p = u.createElement("div");
	p.className = "otn-shadow-root", d.appendChild(p);
	let m = ce({
		client: r,
		locale: i,
		pollIntervalMs: o,
		setIntervalImpl: c?.setInterval,
		clearIntervalImpl: c?.clearInterval
	}), h = n.createRoot(p);
	h.render(t.createElement(Ne, {
		React: t,
		store: m,
		client: r,
		theme: a
	})), o > 0 && m.startPolling(o);
	let g = s === !1 ? Promise.resolve(m.getSnapshot()) : m.initialize();
	typeof l == "function" && g.then((e) => l(e)).catch(() => {});
	let _ = !1;
	function v() {
		if (!_) for (_ = !0, m.dispose(), typeof h.unmount == "function" && h.unmount(); d.firstChild !== null && d.firstChild !== void 0;) d.removeChild(d.firstChild);
	}
	return {
		host: e,
		shadowRoot: d,
		container: p,
		store: m,
		ready: g,
		getSnapshot: m.getSnapshot,
		unmount: v,
		dispose: v
	};
}
//#endregion
//#region web/src/native/browser-entry.js
var Le = "/opentake-studio-route-b/app/native-editor/native-editor.js";
function Re({ host: e, base: t = "/opentake-studio-route-b", locale: n = "en", theme: r = "system", pollIntervalMs: i = 0, fetchImpl: a = globalThis.fetch, timers: o = void 0, autoInitialize: s = !0, onReady: c = void 0 } = {}) {
	if (typeof AbortController != "function") throw Error("AbortController is required");
	let l = new AbortController(), u = b({
		base: t,
		fetchImpl: a,
		signal: l.signal
	}), d;
	try {
		d = Ie({
			host: e,
			React: g,
			ReactDOM: { createRoot: _.createRoot },
			client: u,
			locale: n,
			theme: r,
			pollIntervalMs: i,
			timers: o,
			autoInitialize: s,
			onReady: c
		});
	} catch (e) {
		throw l.abort(), e;
	}
	let f = !1;
	function p() {
		f || (f = !0, l.abort(), d.dispose());
	}
	return {
		...d,
		client: u,
		dispose: p,
		unmount: p
	};
}
//#endregion
var ze = _.createRoot;
export { Le as BUNDLE_PATH, g as React, b as createEngineClient, ze as createRoot, Re as mountNative, Ie as mountNativeEditor };
