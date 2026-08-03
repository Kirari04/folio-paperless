import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BiometricLockController,
  performBiometricUnlockAttempt,
} from '../src/lib/biometric-lock-controller.ts';

function createController(appState = 'active') {
  return new BiometricLockController({ enabled: true, appState });
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('biometric prompts start only while active and only once automatically per generation', async () => {
  const controller = createController('background');
  let prompts = 0;
  const attempt = (currentAppState) => performBiometricUnlockAttempt({
    controller,
    mode: 'automatic',
    currentAppState,
    authenticate: async () => {
      prompts += 1;
      return false;
    },
    onStateChange() {},
  });

  assert.equal(await attempt('background'), false);
  assert.equal(prompts, 0);
  assert.equal(await attempt('active'), false);
  assert.equal(await attempt('active'), false);
  assert.equal(prompts, 1);
  assert.deepEqual(controller.snapshot(), {
    enabled: true,
    appState: 'active',
    locked: true,
    unlocking: false,
    generation: 0,
  });
});

test('successful authentication unlocks while failure leaves manual retry enabled', async () => {
  const controller = createController();
  const states = [];

  assert.equal(await performBiometricUnlockAttempt({
    controller,
    mode: 'automatic',
    currentAppState: 'active',
    authenticate: async () => false,
    onStateChange: (state) => states.push(state),
  }), false);
  assert.equal(controller.snapshot().locked, true);
  assert.equal(controller.snapshot().unlocking, false);

  assert.equal(await performBiometricUnlockAttempt({
    controller,
    mode: 'manual',
    currentAppState: 'active',
    authenticate: async () => true,
    onStateChange: (state) => states.push(state),
  }), true);
  assert.equal(controller.snapshot().locked, false);
  assert.equal(states.some((state) => state.unlocking), true);
});

test('cancellation and native errors always clear Checking and permit retry', async () => {
  for (const authenticate of [
    async () => false,
    async () => { throw new Error('native authentication unavailable'); },
  ]) {
    const controller = createController();
    assert.equal(await performBiometricUnlockAttempt({
      controller,
      mode: 'automatic',
      currentAppState: 'active',
      authenticate,
      onStateChange() {},
    }), false);
    assert.equal(controller.snapshot().locked, true);
    assert.equal(controller.snapshot().unlocking, false);

    assert.equal(await performBiometricUnlockAttempt({
      controller,
      mode: 'manual',
      currentAppState: 'active',
      authenticate: async () => true,
      onStateChange() {},
    }), true);
  }
});

test('backgrounding invalidates an in-flight result without stranding or clearing a newer attempt', async () => {
  const controller = createController();
  const first = deferred();
  const second = deferred();
  const firstRun = performBiometricUnlockAttempt({
    controller,
    mode: 'automatic',
    currentAppState: 'active',
    authenticate: () => first.promise,
    onStateChange() {},
  });
  assert.equal(controller.snapshot().unlocking, true);

  controller.transitionAppState('background');
  assert.equal(controller.snapshot().locked, true);
  assert.equal(controller.snapshot().unlocking, false);
  controller.transitionAppState('active');
  const secondRun = performBiometricUnlockAttempt({
    controller,
    mode: 'automatic',
    currentAppState: 'active',
    authenticate: () => second.promise,
    onStateChange() {},
  });
  assert.equal(controller.snapshot().unlocking, true);

  first.resolve(true);
  assert.equal(await firstRun, false);
  assert.equal(controller.snapshot().locked, true);
  assert.equal(controller.snapshot().unlocking, true);

  second.resolve(true);
  assert.equal(await secondRun, true);
  assert.equal(controller.snapshot().locked, false);
  assert.equal(controller.snapshot().unlocking, false);
});

test('rapid inactive-background-active transitions create one fresh automatic attempt', async () => {
  const controller = createController();
  controller.transitionAppState('inactive');
  const generation = controller.snapshot().generation;
  controller.transitionAppState('background');
  assert.equal(controller.snapshot().generation, generation);
  controller.transitionAppState('active');

  let prompts = 0;
  const run = () => performBiometricUnlockAttempt({
    controller,
    mode: 'automatic',
    currentAppState: 'active',
    authenticate: async () => {
      prompts += 1;
      return false;
    },
    onStateChange() {},
  });
  await Promise.all([run(), run(), run()]);
  assert.equal(prompts, 1);
  assert.equal(controller.snapshot().locked, true);
  assert.equal(controller.snapshot().unlocking, false);
});

test('disabling the lock invalidates in-flight authentication and stale success cannot relock or unlock', async () => {
  const controller = createController();
  const pending = deferred();
  const run = performBiometricUnlockAttempt({
    controller,
    mode: 'automatic',
    currentAppState: 'active',
    authenticate: () => pending.promise,
    onStateChange() {},
  });
  controller.setEnabled(false);
  pending.resolve(true);
  assert.equal(await run, false);
  assert.deepEqual(controller.snapshot(), {
    enabled: false,
    appState: 'active',
    locked: false,
    unlocking: false,
    generation: 1,
  });
});
