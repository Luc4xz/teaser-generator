export async function withRequestTimeout(request, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),timeoutMs);
  try {
    return await request(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The server took too long to respond. Try again.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
