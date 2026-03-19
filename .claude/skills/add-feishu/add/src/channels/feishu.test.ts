import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const sdkRef = vi.hoisted(() => ({
  ws: null as any,
  dispatcher: null as any,
  client: null as any,
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockEventDispatcher {
    handlers: Record<string, (data: unknown) => Promise<void> | void> = {};

    register(map: Record<string, (data: unknown) => Promise<void> | void>) {
      this.handlers = { ...this.handlers, ...map };
    }
  }

  class MockWSClient {
    start = vi.fn();
    stop = vi.fn();
    close = vi.fn();

    constructor() {
      sdkRef.ws = this;
    }
  }

  class MockClient {
    im = {
      message: {
        create: vi.fn().mockResolvedValue({ code: 0 }),
      },
    };

    request = vi.fn().mockResolvedValue({
      code: 0,
      data: { bot: { open_id: 'ou_bot_self' } },
    });

    constructor() {
      sdkRef.client = this;
    }
  }

  const EventDispatcher = function () {
    const d = new MockEventDispatcher();
    sdkRef.dispatcher = d;
    return d;
  } as unknown as typeof MockEventDispatcher;

  return {
    AppType: { SelfBuild: 'SelfBuild' },
    Domain: { Feishu: 'Feishu' },
    LoggerLevel: { info: 'info' },
    EventDispatcher,
    WSClient: MockWSClient,
    Client: MockClient,
  };
});

import { FeishuChannel, type FeishuChannelOpts } from './feishu.js';

function createOpts(
  overrides?: Partial<FeishuChannelOpts>,
): FeishuChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'fs:oc_test_group': {
        name: 'Feishu Group',
        folder: 'feishu-group',
        trigger: '@Andy',
        added_at: '2026-03-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function inboundEvent(overrides?: Record<string, unknown>) {
  return {
    sender: { sender_id: { open_id: 'ou_sender' } },
    message: {
      message_id: 'om_msg_1',
      chat_id: 'oc_test_group',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello from feishu' }),
      create_time: '1710000000000',
      mentions: [],
    },
    ...overrides,
  };
}

describe('FeishuChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('connects and starts ws client', async () => {
    const channel = new FeishuChannel('cli_x', 'sec_x', createOpts());
    await channel.connect();

    expect(channel.isConnected()).toBe(true);
    expect(sdkRef.ws.start).toHaveBeenCalledTimes(1);
  });

  it('owns fs: JIDs', () => {
    const channel = new FeishuChannel('cli_x', 'sec_x', createOpts());
    expect(channel.ownsJid('fs:oc_test_group')).toBe(true);
    expect(channel.ownsJid('tg:123')).toBe(false);
  });

  it('disconnects cleanly', async () => {
    const channel = new FeishuChannel('cli_x', 'sec_x', createOpts());
    await channel.connect();

    await channel.disconnect();

    expect(channel.isConnected()).toBe(false);
    expect(sdkRef.ws.stop).toHaveBeenCalled();
  });

  it('stores inbound text for registered chat', async () => {
    const opts = createOpts();
    const channel = new FeishuChannel('cli_x', 'sec_x', opts);
    await channel.connect();

    await sdkRef.dispatcher.handlers['im.message.receive_v1'](inboundEvent());

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'fs:oc_test_group',
      expect.any(String),
      undefined,
      'feishu',
      true,
    );

    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_test_group',
      expect.objectContaining({
        id: 'om_msg_1',
        sender: 'ou_sender',
        content: 'hello from feishu',
      }),
    );
  });

  it('ignores inbound from unregistered chat', async () => {
    const opts = createOpts({ registeredGroups: vi.fn(() => ({})) });
    const channel = new FeishuChannel('cli_x', 'sec_x', opts);
    await channel.connect();

    await sdkRef.dispatcher.handlers['im.message.receive_v1'](inboundEvent());

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('adds trigger prefix when group message has mentions', async () => {
    const opts = createOpts();
    const channel = new FeishuChannel('cli_x', 'sec_x', opts);
    await channel.connect();

    const event = inboundEvent({
      message: {
        message_id: 'om_msg_2',
        chat_id: 'oc_test_group',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'please run this' }),
        create_time: '1710000000000',
        mentions: [{ key: '@_bot_1', id: { open_id: 'ou_bot_self' } }],
      },
    });

    await sdkRef.dispatcher.handlers['im.message.receive_v1'](event);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_test_group',
      expect.objectContaining({ content: '@Andy please run this' }),
    );
  });

  it('does not double-prefix when trigger already exists', async () => {
    const opts = createOpts();
    const channel = new FeishuChannel('cli_x', 'sec_x', opts);
    await channel.connect();

    const event = inboundEvent({
      message: {
        message_id: 'om_msg_3',
        chat_id: 'oc_test_group',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@Andy please run this' }),
        create_time: '1710000000000',
        mentions: [{ key: '@_bot_1', id: { open_id: 'ou_bot_self' } }],
      },
    });

    await sdkRef.dispatcher.handlers['im.message.receive_v1'](event);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_test_group',
      expect.objectContaining({ content: '@Andy please run this' }),
    );
  });

  it('does not prefix when only non-bot users are mentioned', async () => {
    const opts = createOpts();
    const channel = new FeishuChannel('cli_x', 'sec_x', opts);
    await channel.connect();

    const event = inboundEvent({
      message: {
        message_id: 'om_msg_4',
        chat_id: 'oc_test_group',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello team' }),
        create_time: '1710000000000',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_someone_else' } }],
      },
    });

    await sdkRef.dispatcher.handlers['im.message.receive_v1'](event);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_test_group',
      expect.objectContaining({ content: 'hello team' }),
    );
  });

  it('sends outbound text through feishu api', async () => {
    const channel = new FeishuChannel('cli_x', 'sec_x', createOpts());
    await channel.connect();

    await channel.sendMessage('fs:oc_test_group', 'outbound hello');

    expect(sdkRef.client.im.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_test_group',
        msg_type: 'text',
        content: JSON.stringify({ text: 'outbound hello' }),
      },
    });
  });
});
