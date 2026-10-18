export const embeddedChat = window.parent !== window;

export function requireHostIdentity() {
  if (embeddedChat) {
    window.parent.postMessage({ type: 'camp-chat:identity-required' }, window.location.origin);
  }
}

export function initializeHostNavigation({ activate, deactivate }) {
  if (!embeddedChat) return;
  let active = false;
  let activation = Promise.resolve();
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== window.location.origin || event.data?.type !== 'camp-chat:visibility') return;
    const next = event.data.visible === true;
    if (next === active) return;
    active = next;
    if (active) {
      // Serialize activations so an older locale/session refresh cannot win a later visit.
      activation = activation.then(activate).catch(error => console.error('Chat activation failed', error));
    } else deactivate();
  });
  window.parent.postMessage({ type: 'camp-chat:ready' }, window.location.origin);
}
