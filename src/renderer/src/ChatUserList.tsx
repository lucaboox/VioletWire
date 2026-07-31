import { Gem, MessageSquare, Search, Sword, Users, Video, X } from "lucide-react";
import type { ComponentType } from "react";
import { useMemo, useState } from "react";
import type { ChatMessage } from "../../shared/chat";
import type { ChatUserListEntry, ChatUserRole } from "../../shared/chat-content";
import { readableUsernameColor } from "../../shared/chat-color";

interface ChatUserListProps {
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

// Echoes each service's own badge shorthand: a sword for moderators, a gem for
// VIPs, so a section reads at a glance.
const sectionIcons: Record<ChatUserRole, ComponentType<{ size?: number }>> = {
  broadcaster: Video,
  moderator: Sword,
  vip: Gem,
  chatter: MessageSquare,
};

const sectionOrder: ChatUserRole[] = ["broadcaster", "moderator", "vip", "chatter"];

export function ChatUserList({
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
          return (
          <section className="chat-user-section" key={role}>
            <h3>
              <span className="chat-user-section-name">
                <SectionIcon size={12} />
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
