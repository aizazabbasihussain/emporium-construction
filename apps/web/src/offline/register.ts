/** BR-1: registers the service worker that keeps the app shell available offline. */
export async function registerServiceWorker(
  container: Pick<Navigator, 'serviceWorker'> | { serviceWorker?: undefined } = navigator,
): Promise<boolean> {
  if (container.serviceWorker === undefined) return false;
  try {
    await container.serviceWorker.register('/sw.js', { scope: '/' });
    return true;
  } catch {
    // The app works without it; only the offline shell is lost.
    return false;
  }
}
