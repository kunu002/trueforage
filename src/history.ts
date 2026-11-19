import type { Memento } from 'vscode';

export interface SavedChat {
  id: string; title: string; updatedAt: number; model: string; workMode: 'agent' | 'review' | 'ask';
  messages: { id: string; role: 'user' | 'assistant'; content: string; status?: string }[];
}

/** Local text history. Runtime credentials, tool arguments and source snapshots are never persisted here. */
export class ChatHistory {
  private chats: SavedChat[];
  constructor(private readonly storage: Memento) { this.chats = storage.get<SavedChat[]>('trueforage.chats', []).slice(0, 20); }
  list(): { id: string; title: string; updatedAt: number }[] { return this.chats.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })); }
  get(id: string): SavedChat | undefined { return this.chats.find(chat => chat.id === id); }
  async save(chat: SavedChat): Promise<void> {
    if (!chat.messages.some(message => message.role === 'user')) return;
    const bounded = { ...chat, title: chat.title.slice(0, 100),
      messages: chat.messages.slice(-40).map(message => ({ ...message, content: message.content.slice(-12_000) })) };
    this.chats = [bounded, ...this.chats.filter(other => other.id !== chat.id)].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
    await this.storage.update('trueforage.chats', this.chats);
  }
}
