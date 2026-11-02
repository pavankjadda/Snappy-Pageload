"use strict";

// Keep Firefox's registration lifecycle while translating only the Safari build.
if (!browser.contentScripts?.register) {
  const prefix = "fpl-safari-";
  let sequence = 0;
  const generation = crypto.randomUUID();
  const ownPrefix = `${prefix}${generation}-`;
  let snapshot;

  // Registrations persist across sessions, and Safari event pages can restart while earlier
  // registrations remain active; keep them until the complete replacement has been registered.
  // A failed snapshot is dropped so the next call retries instead of failing until a restart.
  function staleScripts() {
    snapshot ??= browser.scripting.getRegisteredContentScripts().then(
      (scripts) => scripts.map(({ id }) => id).filter((id) => id.startsWith(prefix) && !id.startsWith(ownPrefix)),
      (error) => {
        snapshot = undefined;
        throw error;
      }
    );
    return snapshot;
  }

  globalThis.fasterPageloadContentScripts = {
    async register({ js, ...details }) {
      await staleScripts();
      const id = `${ownPrefix}${++sequence}`;
      await browser.scripting.registerContentScripts([
        { ...details, id, js: js.map(({ file }) => file), persistAcrossSessions: true },
      ]);
      return { unregister: () => browser.scripting.unregisterContentScripts({ ids: [id] }) };
    },
    async finishUpdate() {
      const stale = await staleScripts();
      if (stale.length) {
        await browser.scripting.unregisterContentScripts({ ids: stale });
        snapshot = Promise.resolve([]);
      }
    },
  };
}
