/*
 * solve-worker.js — Web Worker wrapper around the three solver modules
 * so big solves never freeze the page. app.js posts
 *   { id, kind: 'frame' | 'weapon' | 'amp', input, bundle }
 * and receives back
 *   { id, ok: true, result }  or  { id, ok: false, error }.
 *
 * The solver files are plain IIFEs that export onto `window` (browser)
 * or `module` (Node) — a classic worker has neither, so `window` is
 * aliased to the worker global scope BEFORE importing them; their UMD
 * guards then attach Solver / WeaponSolver / Modular to the global
 * scope where this script can reach them.
 */
'use strict';
var window = self;
importScripts('solver.js', 'weaponSolver.js', 'modular.js');

self.onmessage = function (e) {
  var msg = e.data || {};
  var id = msg.id;
  try {
    var result = null;
    if (msg.kind === 'frame') {
      result = Solver.solve(msg.input, msg.bundle);
    } else if (msg.kind === 'weapon') {
      result = WeaponSolver.solve(msg.input, msg.bundle);
    } else if (msg.kind === 'amp') {
      result = Modular.solveAmp(msg.input, msg.bundle);
    } else {
      throw new Error('solve-worker: unknown kind "' + msg.kind + '"');
    }
    self.postMessage({ id: id, ok: true, result: result });
  } catch (err) {
    self.postMessage({ id: id, ok: false, error: String((err && err.message) || err) });
  }
};
