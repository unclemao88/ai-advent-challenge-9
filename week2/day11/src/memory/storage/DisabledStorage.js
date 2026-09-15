import { StorageProvider } from './StorageProvider.js';

/**
 * The layer is switched off: reads find nothing and writes are dropped, so the
 * layer contributes nothing to the context. Files a previous JSON mode left on
 * disk are not touched — switching back to JSON brings them back.
 */
export class DisabledStorage extends StorageProvider {
  constructor() {
    super('disabled');
  }

  get enabled() {
    return false;
  }

  async read() {
    return undefined;
  }

  async write() {}
}
