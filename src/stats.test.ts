import test from "node:test";
import assert from "node:assert/strict";
import { regress } from "./stats.js";

test("regress recovers known coefficients by name", () => {
  const x1 = { name: "x1", values: [0, 1, 2, 3, 4, 5, 6, 7] };
  // Independent of x1 (not a linear function of it), so X'X stays invertible.
  const x2 = { name: "x2", values: [1, 3, 2, 5, 4, 7, 6, 8] };
  // y = 2 + 3*x1 - 1*x2, exactly.
  const y = x1.values.map((v, i) => 2 + 3 * v - 1 * x2.values[i]);

  const fit = regress([x1, x2], y);
  assert.ok(fit);
  assert.deepEqual(fit.kept, ["x1", "x2"]);

  const b1 = fit.coef("x1");
  const b2 = fit.coef("x2");
  assert.ok(b1);
  assert.ok(b2);
  assert.ok(Math.abs(b1.coefficient - 3) < 1e-9);
  assert.ok(Math.abs(b2.coefficient - -1) < 1e-9);
});

test("regress drops a constant column and reports the survivors", () => {
  const x = { name: "x", values: [1, 2, 3, 4, 5, 6] };
  const c = { name: "c", values: [9, 9, 9, 9, 9, 9] }; // no variance
  const y = [2, 4, 6, 8, 10, 12]; // y = 2*x

  const fit = regress([x, c], y);
  assert.ok(fit);
  assert.deepEqual(fit.kept, ["x"]); // c dropped
  assert.equal(fit.coef("c"), undefined); // dropped -> undefined
  assert.equal(fit.coef("nope"), undefined); // absent name -> undefined

  const bx = fit.coef("x");
  assert.ok(bx);
  assert.ok(Math.abs(bx.coefficient - 2) < 1e-9);
});

test("regress returns null when the model is under-determined", () => {
  // n = 2 rows, p = 2 coefficients (intercept + x) -> dfResid = 0.
  const fit = regress([{ name: "x", values: [1, 2] }], [1, 2]);
  assert.equal(fit, null);
});
