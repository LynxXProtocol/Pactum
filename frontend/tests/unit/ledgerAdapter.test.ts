import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { LedgerAdapter } from '../../src/lib/wallet-adapters/ledger-adapter.ts';

const originalNavigator = globalThis.navigator;

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', {
    value: originalNavigator,
    configurable: true,
  });
});

function stubNavigator(props: Record<string, unknown>) {
  Object.defineProperty(globalThis, 'navigator', {
    value: props,
    configurable: true,
  });
}

describe('LedgerAdapter', () => {
  it('exposes the WalletAdapter shape expected by the wallet-adapters registry', () => {
    assert.equal(LedgerAdapter.id, 'ledger');
    assert.equal(typeof LedgerAdapter.connect, 'function');
    assert.equal(typeof LedgerAdapter.disconnect, 'function');
    assert.equal(typeof LedgerAdapter.isAvailable, 'function');
  });

  it('is available when the browser exposes WebUSB', async () => {
    stubNavigator({ usb: {} });
    assert.equal(await LedgerAdapter.isAvailable(), true);
  });

  it('is available when the browser exposes WebBluetooth', async () => {
    stubNavigator({ bluetooth: {} });
    assert.equal(await LedgerAdapter.isAvailable(), true);
  });

  it('is unavailable when neither WebUSB nor WebBluetooth is exposed', async () => {
    stubNavigator({});
    assert.equal(await LedgerAdapter.isAvailable(), false);
  });
});
