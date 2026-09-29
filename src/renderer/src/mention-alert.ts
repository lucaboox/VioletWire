import { messageMentionsLogin, type ChatMessage } from "../../shared/chat";
import { parseChannelKey, type Platform } from "../../shared/platform";

/** The viewer's own name on each service, lowercased; empty when signed out. */
export interface ViewerNames {
  twitch: string;
  kick: string;
}

/**
 * The name to look for in a channel's chat. Each service has its own account,
 * and somebody's Kick name is often not their Twitch one, so a mention in Kick
 * chat has to be matched against the Kick name.
 */
export function viewerNameFor(channel: string | null, names: ViewerNames): string {
  if (!channel) return "";
  const platform: Platform = parseChannelKey(channel).platform;
  return platform === "kick" ? names.kick : names.twitch;
}

/**
 * Whether a message arriving now should sound the mention alert: said live
 * rather than replayed from history, naming the viewer, in one of the chats
 * they have open. Channels are compared by login because a message carries
 * the bare name while the app keys channels by service ("kick:name").
 */
export function shouldAlertMention(
  message: ChatMessage,
  names: ViewerNames,
  openChannels: Iterable<string>,
): boolean {
  if (message.historical || message.deleted) return false;
  const said = message.channel.toLowerCase();
  for (const channel of openChannels) {
    if (parseChannelKey(channel).login.toLowerCase() !== said) continue;
    return messageMentionsLogin(message, viewerNameFor(channel, names));
  }
  return false;
}
