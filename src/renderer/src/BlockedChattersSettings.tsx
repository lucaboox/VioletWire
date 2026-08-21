import { Ban, Plus, X } from "lucide-react";
import { useState } from "react";

import {
  isBlockableChatter,
  normalizeBlockedChatter,
} from "../../shared/blocked-chatters";
import { blockChatter, unblockChatter, useBlockedChatters } from "./blocked-chatters";
import "./blocked-chatters.css";

/**
 * The whole blocked list, for adding somebody who is not in chat right now and
 * for letting anybody back in. Blocking from a chatter's card covers the common
 * case; this is where the list itself is kept.
 */
export function BlockedChattersSettings() {
  const blocked = useBlockedChatters();
  const [typed, setTyped] = useState("");
  const login = normalizeBlockedChatter(typed);
  const alreadyBlocked = blocked.has(login);
  const canAdd = isBlockableChatter(typed) && !alreadyBlocked;
  const names = [...blocked].sort();

  function add(): void {
    if (!canAdd) return;
    void blockChatter(login);
    setTyped("");
  }

  return (
    <div className="blocked-chatters">
      <form
        className="blocked-chatters-add"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          aria-label="Username to block"
          maxLength={40}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="Add a username…"
          spellCheck={false}
          value={typed}
        />
        <button
          aria-label="Block this username"
          className="secondary-button"
          disabled={!canAdd}
          title={
            alreadyBlocked ? `@${login} is already blocked` : "Block this username"
          }
          type="submit"
        >
          <Plus size={15} />
          Block
        </button>
      </form>

      {names.length === 0 ? (
        <p className="blocked-chatters-empty">
          <Ban size={14} />
          Nobody is blocked. Block someone from their card in chat, or add a
          username above.
        </p>
      ) : (
        <ul className="blocked-chatters-list">
          {names.map((name) => (
            <li key={name}>
              <span>@{name}</span>
              <button
                aria-label={`Unblock ${name}`}
                onClick={() => void unblockChatter(name)}
                title={`Unblock @${name}`}
                type="button"
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
