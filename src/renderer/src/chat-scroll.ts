export interface ChatScrollAnchor {
  fallbackScrollTop: number;
  visibleRows: Array<{ id: string; top: number }>;
}

export function captureChatScrollAnchor(host: HTMLElement): ChatScrollAnchor {
  const hostTop = host.getBoundingClientRect().top;
  const visibleRows = [...host.querySelectorAll<HTMLElement>("[data-chat-message-id]")]
    .filter((row) => row.getBoundingClientRect().bottom > hostTop)
    .slice(0, 6)
    .map((row) => ({
      id: row.dataset.chatMessageId ?? "",
      top: row.getBoundingClientRect().top - hostTop,
    }))
    .filter(({ id }) => id.length > 0);

  return { fallbackScrollTop: host.scrollTop, visibleRows };
}

export function restoreChatScrollAnchor(
  host: HTMLElement,
  anchor: ChatScrollAnchor,
): void {
  const hostTop = host.getBoundingClientRect().top;
  const rows = [...host.querySelectorAll<HTMLElement>("[data-chat-message-id]")];
  for (const candidate of anchor.visibleRows) {
    const row = rows.find((item) => item.dataset.chatMessageId === candidate.id);
    if (!row) continue;
    host.scrollTop += row.getBoundingClientRect().top - hostTop - candidate.top;
    return;
  }
  host.scrollTop = anchor.fallbackScrollTop;
}
