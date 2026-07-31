import { Gem, MessageSquare, Search, Sword, Users, Video, X } from "lucide-react";
import type { ComponentType } from "react";
import { useMemo, useState } from "react";
import type { ChatBadgeAsset, ChatMessage } from "../../shared/chat";
import type { ChatUserListEntry, ChatUserRole } from "../../shared/chat-content";
import { readableUsernameColor } from "../../shared/chat-color";
import { ChatBadge } from "./ChatBadge";

interface ChatUserListProps {
  badges: Map<string, ChatBadgeAsset>;
  entries: ChatUserListEntry[];
  oledMode: boolean;
  onClose: () => void;
  onOpenUser: (message: ChatMessage, anchor: DOMRect) => void;
  platform: "twitch" | "kick";
}

const sectionLabels: Record<ChatUserRole, string> = {
  broadcaster: "Broadcaster",
  moderator: "Moderators",
  vip: "VIPs",
  chatter: "Recently active",
};

// Drawn only when the service has no badge of its own for the role (Kick has no
// broadcaster badge, and neither service badges an ordinary chatter).
const sectionIcons: Record<ChatUserRole, ComponentType<{ size?: number }>> = {
  broadcaster: Video,
  moderator: Sword,
  vip: Gem,
  chatter: MessageSquare,
};

/** Twitch's own badge for a role, from the channel's loaded badge set. */
const twitchBadgeKeys: Partial<Record<ChatUserRole, string>> = {
  broadcaster: "broadcaster/1",
  moderator: "moderator/1",
  vip: "vip/1",
};

/** Kick draws these from its own artwork rather than an image URL. */
const kickGlyphRoles: Partial<Record<ChatUserRole, string>> = {
  moderator: "moderator",
  vip: "vip",
};

const sectionOrder: ChatUserRole[] = ["broadcaster", "moderator", "vip", "chatter"];

export function ChatUserList({
  badges,
  entries,
  oledMode,
  onClose,
  onOpenUser,
  platform,
}: ChatUserListProps) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const sections = useMemo(
    () =>
      sectionOrder
        .map((role) => ({
          role,
          users: entries.filter(({ message, role: entryRole }) => {
            if (entryRole !== role) return false;
            if (!normalizedQuery) return true;
            return (
              message.displayName.toLowerCase().includes(normalizedQuery) ||
              message.login.toLowerCase().includes(normalizedQuery)
            );
          }),
        }))
        .filter(({ users }) => users.length > 0),
    [entries, normalizedQuery],
  );

  return (
    <section
      aria-label={`${platform === "kick" ? "Kick" : "Twitch"} users in chat`}
      className={`chat-user-list ${platform}`}
      role="dialog"
    >
      <header>
        <div>
          <Users aria-hidden="true" size={17} />
          <strong>Users in chat</strong>
        </div>
        <button aria-label="Close user list" onClick={onClose} title="Close" type="button">
          <X size={16} />
        </button>
      </header>
      <label className="chat-user-search">
        <Search aria-hidden="true" size={15} />
        <input
          aria-label="Search users in chat"
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search users"
          value={query}
        />
      </label>
      <div className="chat-user-list-scroll">
        {sections.map(({ role, users }) => {
          const SectionIcon = sectionIcons[role];
          // Prefer the service's real badge art, so a section is marked with the
          // same badge these users wear in chat.
          const badgeKey = twitchBadgeKeys[role];
          const glyph = kickGlyphRoles[role];
          const badge: ChatBadgeAsset | undefined =
            platform === "kick"
              ? glyph
                ? { key: `kick-${role}`, title: sectionLabels[role], imageUrl: "", glyph }
                : undefined
              : badgeKey
                ? badges.get(badgeKey)
                : undefined;
          return (
          <section className="chat-user-section" key={role}>
            <h3>
              <span className="chat-user-section-name">
                {badge ? (
                  <ChatBadge badge={badge} loading="eager" />
                ) : (
                  <SectionIcon size={12} />
                )}
                {sectionLabels[role]}
              </span>
              <span className="chat-user-section-count">{users.length}</span>
            </h3>
            {users.map(({ message }) => (
              <button
                key={message.login}
                onClick={(event) => {
                  // The list stays open so several users can be opened in a row;
                  // the header's close button dismisses it.
                  onOpenUser(message, event.currentTarget.getBoundingClientRect());
                }}
                type="button"
              >
                <strong
                  style={{
                    color: readableUsernameColor(
                      message.color,
                      oledMode ? "#000000" : "#18181b",
                    ),
                  }}
                >
                  {message.displayName || message.login}
                </strong>
                {message.displayName.toLowerCase() !== message.login && (
                  <small>@{message.login}</small>
                )}
              </button>
            ))}
          </section>
          );
        })}
        {sections.length === 0 && (
          <div className="chat-user-list-empty">No recently active users match that search.</div>
        )}
      </div>
      <footer>
        Showing users observed in recent chat
      </footer>
    </section>
  );
}
