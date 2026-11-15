/*
 * Animated aurora sky drawn with a WebGL fragment shader.
 * Renders at reduced resolution (the aurora is soft) to save battery.
 * If WebGL is unavailable, the canvas falls back to a CSS gradient (see .aurora--fallback).
 */
(function (root) {
  'use strict';

  var VERTEX_SRC = [
    'attribute vec2 aPos;',
    'void main() { gl_Position = vec4(aPos, 0.0, 1.0); }',
  ].join('\n');

  var FRAGMENT_SRC = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform vec2 iResolution;',
    'uniform float iTime;',
    '',
    'float hash(vec2 p) {',
    '  p = fract(p * vec2(123.34, 456.21));',
    '  p += dot(p, p + 45.32);',
    '  return fract(p.x * p.y);',
    '}',
    '',
    'float noise(vec2 p) {',
    '  vec2 i = floor(p);',
    '  vec2 f = fract(p);',
    '  float a = hash(i);',
    '  float b = hash(i + vec2(1.0, 0.0));',
    '  float c = hash(i + vec2(0.0, 1.0));',
    '  float d = hash(i + vec2(1.0, 1.0));',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);',
    '}',
    '',
    'float fbm(vec2 p) {',
    '  float v = 0.0;',
    '  float amp = 0.5;',
    '  for (int i = 0; i < 4; i++) {',
    '    v += amp * noise(p);',
    '    p = p * 2.03 + vec2(1.7, 9.2);',
    '    amp *= 0.5;',
    '  }',
    '  return v;',
    '}',
    '',
    '// One hanging curtain: bright lower edge, glow and vertical rays rising upward.',
    'vec3 curtain(vec2 uv, float t, float seed, float baseY, vec3 lowCol, vec3 highCol) {',
    '  float x = uv.x * 2.4;',
    '  float wave = 0.07 * sin(x * 1.7 + t * 0.35 + seed)',
    '             + 0.035 * sin(x * 4.1 - t * 0.5 + seed * 2.0)',
    '             + 0.12 * (fbm(vec2(x * 0.9 + seed, t * 0.08)) - 0.5);',
    '  float edge = baseY + wave;',
    '  float d = uv.y - edge;',
    '  float glow = d > 0.0 ? exp(-d * d * 700.0) : exp(d * 4.0);',
    '  float rays = fbm(vec2(x * 9.0 + seed * 3.0, t * 0.15 + d * 1.2));',
    '  rays = 0.25 + 1.1 * rays * rays;',
    '  float fadeTop = smoothstep(0.0, 0.22, uv.y);',
    '  vec3 col = mix(lowCol, highCol, clamp(-d * 2.5, 0.0, 1.0));',
    '  return col * glow * rays * fadeTop;',
    '}',
    '',
    'void main() {',
    '  vec2 uv = vec2(gl_FragCoord.x / iResolution.x, 1.0 - gl_FragCoord.y / iResolution.y);',
    '  float aspect = iResolution.x / iResolution.y;',
    '  float t = iTime;',
    '',
    '  vec3 col = mix(vec3(0.004, 0.010, 0.030), vec3(0.015, 0.035, 0.080), uv.y);',
    '',
    '  // twinkling stars',
    '  vec2 sp = vec2(uv.x * aspect, uv.y) * 70.0;',
    '  vec2 id = floor(sp);',
    '  float h = hash(id);',
    '  vec2 gv = fract(sp) - 0.5 - (vec2(hash(id + 7.0), hash(id + 13.0)) - 0.5) * 0.6;',
    '  float star = step(0.972, h) * smoothstep(0.10, 0.0, length(gv));',
    '  float tw = 0.55 + 0.45 * sin(t * (1.2 + h * 2.5) + h * 40.0);',
    '  col += vec3(0.85, 0.90, 1.0) * star * tw * (1.0 - uv.y * 0.7);',
    '',
    '  vec3 aur = vec3(0.0);',
    '  aur += curtain(uv, t, 0.0, 0.46, vec3(0.15, 1.00, 0.55), vec3(0.10, 0.55, 0.85));',
    '  aur += 0.75 * curtain(uv, t * 0.8, 3.1, 0.60, vec3(0.20, 0.95, 0.75), vec3(0.55, 0.30, 0.95));',
    '  aur += 0.60 * curtain(uv, t * 1.15, 6.7, 0.32, vec3(0.30, 1.00, 0.45), vec3(0.85, 0.25, 0.75));',
    '  col += aur * 0.85;',
    '',
    '  col += vec3(0.02, 0.09, 0.07) * smoothstep(0.65, 1.0, uv.y);',
    '  vec2 c = uv - 0.5;',
    '  col *= 1.0 - dot(c, c) * 0.9;',
    '',
    '  col = 1.0 - exp(-col * 1.4);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}',
  ].join('\n');

  function Aurora(canvas, options) {
    this.canvas = canvas;
    this.renderScale = (options && options.renderScale) || 0.5;
    this.gl = null;
    this.ok = false;
    this._init();

    var self = this;
    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      self.ok = false;
    });
    canvas.addEventListener('webglcontextrestored', function () {
      self._init();
    });
  }

  Aurora.prototype._init = function () {
    var canvas = this.canvas;
    var gl = null;
    try {
      var attrs = { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' };
      gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    } catch (e) {
      gl = null;
    }
    if (!gl) return this._fallback();

    var vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    var fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    if (!vs || !fs) return this._fallback();

    var program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('Aurora: link failed', gl.getProgramInfoLog(program));
      return this._fallback();
    }
    gl.useProgram(program);

    // One triangle that covers the whole screen.
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.gl = gl;
    this.uResolution = gl.getUniformLocation(program, 'iResolution');
    this.uTime = gl.getUniformLocation(program, 'iTime');
    this.ok = true;
    canvas.classList.remove('aurora--fallback');
    this.resize();
  };

  Aurora.prototype._fallback = function () {
    this.ok = false;
    this.canvas.classList.add('aurora--fallback');
  };

  /** Match the canvas backing store to its on-screen size × renderScale. */
  Aurora.prototype.resize = function () {
    if (!this.ok) return;
    var dpr = Math.min(root.devicePixelRatio || 1, 2);
    var rect = this.canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width * dpr * this.renderScale));
    var h = Math.max(1, Math.round(rect.height * dpr * this.renderScale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
    this.gl.uniform2f(this.uResolution, w, h);
  };

  Aurora.prototype.render = function (timeSeconds) {
    if (!this.ok) return;
    var gl = this.gl;
    gl.uniform1f(this.uTime, timeSeconds);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('Aurora: shader compile failed', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  root.Aurora = Aurora;
})(this);
