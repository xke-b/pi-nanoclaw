import * as Lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

interface FeishuMessageEvent {
  sender?: {
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: 'p2p' | 'group' | 'private';
    message_type?: string;
    content?: string;
    create_time?: string;
    mentions?: Array<{
      key?: string;
      id?: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      name?: string;
    }>;
  };
}

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private readonly appId: string;
  private readonly appSecret: string;
  private readonly opts: FeishuChannelOpts;

  private wsClient: Lark.WSClient | null = null;
  private eventDispatcher: Lark.EventDispatcher | null = null;
  private client: Lark.Client | null = null;
  private connected = false;
  private botOpenId: string | null = null;

  constructor(appId: string, appSecret: string, opts: FeishuChannelOpts) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    this.client = new Lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
    });

    this.eventDispatcher = new Lark.EventDispatcher({});
    this.eventDispatcher.register({
      'im.message.receive_v1': async (data) => {
        try {
          await this.handleInboundMessage(data as FeishuMessageEvent);
        } catch (err) {
          logger.error({ err }, 'Feishu: failed to process inbound message');
        }
      },
    });

    await this.initBotIdentity();

    this.wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.info,
    });

    this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    this.connected = true;
    logger.info({ botOpenId: this.botOpenId || undefined }, 'Feishu bot connected');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Feishu client not initialized');
      return;
    }

    const chatId = jid.replace(/^fs:/, '').trim();
    if (!chatId) {
      logger.warn({ jid }, 'Feishu: invalid target jid');
      return;
    }

    const MAX_LENGTH = 3000;
    const chunks = splitMessage(text, MAX_LENGTH);

    try {
      for (const chunk of chunks) {
        const response = await (this.client as any).im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: chunk }),
          },
        });

        if (response?.code !== 0) {
          throw new Error(response?.msg || `code ${response?.code ?? 'unknown'}`);
        }
      }

      logger.info({ jid, length: text.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('fs:');
  }

  async disconnect(): Promise<void> {
    if (!this.wsClient) return;

    try {
      const ws = this.wsClient as unknown as { stop?: () => void; close?: () => void };
      ws.stop?.();
      ws.close?.();
    } catch (err) {
      logger.debug({ err }, 'Feishu: ws close failed');
    }

    this.wsClient = null;
    this.eventDispatcher = null;
    this.client = null;
    this.connected = false;
    this.botOpenId = null;
    logger.info('Feishu bot stopped');
  }

  private async initBotIdentity(): Promise<void> {
    if (!this.client) return;

    try {
      const response = await (this.client as any).request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
        data: {},
      });

      const bot = response?.bot || response?.data?.bot;
      const openId = bot?.open_id;
      if (typeof openId === 'string' && openId.trim()) {
        this.botOpenId = openId.trim();
      }
    } catch (err) {
      logger.debug({ err }, 'Feishu: failed to fetch bot identity');
    }
  }

  private async handleInboundMessage(event: FeishuMessageEvent): Promise<void> {
    const message = event.message;
    if (!message) return;

    const chatId = (message.chat_id || '').trim();
    if (!chatId) return;

    const messageType = (message.message_type || '').trim();
    if (messageType && messageType !== 'text') return;

    const rawText = parseFeishuText(message.content || '');
    if (!rawText) return;

    const chatJid = `fs:${chatId}`;
    const isGroup = message.chat_type === 'group';
    const timestamp = parseCreateTime(message.create_time);

    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered Feishu chat');
      return;
    }

    let content = rawText.trim();
    if (
      isGroup &&
      isBotMentioned(message, this.botOpenId) &&
      !TRIGGER_PATTERN.test(content)
    ) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    const sender =
      event.sender?.sender_id?.open_id ||
      event.sender?.sender_id?.user_id ||
      event.sender?.sender_id?.union_id ||
      'unknown';

    this.opts.onMessage(chatJid, {
      id: message.message_id || `${Date.now()}`,
      chat_jid: chatJid,
      sender,
      sender_name: sender,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, sender }, 'Feishu message stored');
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const parts: string[] = [];
  for (let i = 0; i < text.length; i += maxLength) {
    parts.push(text.slice(i, i + maxLength));
  }
  return parts;
}

function parseCreateTime(raw?: string): string {
  if (!raw) return new Date().toISOString();

  const num = Number(raw);
  if (!Number.isFinite(num)) return new Date().toISOString();

  const millis = num > 1_000_000_000_000 ? num : num * 1000;
  return new Date(millis).toISOString();
}

function isBotMentioned(
  message: FeishuMessageEvent['message'],
  botOpenId: string | null,
): boolean {
  const mentions = message?.mentions || [];
  if (mentions.length === 0) return false;

  if (botOpenId) {
    return mentions.some((m) => m.id?.open_id === botOpenId);
  }

  // Fallback for early startup edge cases where bot identity probe fails.
  return true;
}

function parseFeishuText(content: string): string {
  if (!content) return '';

  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return content;
  }
}

registerChannel('feishu', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const appId = process.env.FEISHU_APP_ID || envVars.FEISHU_APP_ID || '';
  const appSecret =
    process.env.FEISHU_APP_SECRET || envVars.FEISHU_APP_SECRET || '';

  if (!appId || !appSecret) {
    logger.warn('Feishu: FEISHU_APP_ID/FEISHU_APP_SECRET not set');
    return null;
  }

  return new FeishuChannel(appId, appSecret, opts);
});
