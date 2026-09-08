import assert from "node:assert/strict";
import test from "node:test";
import { compileProfileRegistry } from "./compile-profile.mjs";

test("compiles the profile registry with the required public interface", () => {
  const artifact = compileProfileRegistry();
  assert.ok(artifact.bytecode.length > 2);
  assert.ok(artifact.deployedBytecode.length > 2);

  const functions = artifact.abi.filter((item) => item.type === "function");
  const events = artifact.abi.filter((item) => item.type === "event");
  assert.deepEqual(functions.map((item) => item.name).sort(), ["profileOf", "setProfile"]);
  assert.deepEqual(events.map((item) => item.name), ["ProfileSet"]);

  const setter = functions.find((item) => item.name === "setProfile");
  assert.equal(setter.stateMutability, "nonpayable");
  assert.equal(setter.inputs[0].type, "uint8");
});
