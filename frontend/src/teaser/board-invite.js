const BOARD_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function parseBoardInvite(value, pageUrl) {
  const input = value.trim();
  if (BOARD_ID.test(input)) return input;

  try {
    const link = new URL(input, pageUrl);
    const id = link.searchParams.get('board')?.trim();
    return /^https?:$/.test(link.protocol) && id && BOARD_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}
