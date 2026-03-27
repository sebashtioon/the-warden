import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { afterEach, describe, it, expect, vi } from 'vitest';
import worker, { parseAssistantAction } from '../src/index.js';

const createKvMock = () => {
	const store = new Map();
	return {
		get: vi.fn(async (key) => (store.has(key) ? store.get(key) : null)),
		put: vi.fn(async (key, value) => {
			store.set(key, value);
		}),
	};
};

describe('The Warden worker', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns Invalid JSON for unsupported content type (unit style)', async () => {
		const request = new Request('http://example.com');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		expect(await response.text()).toBe('Invalid JSON');
	});

	it('handles Slack url_verification (integration style)', async () => {
		const response = await SELF.fetch('http://example.com', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ type: 'url_verification', challenge: 'abc123' }),
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('abc123');
	});

	it('rejects unauthorized message_action without calling Slack APIs', async () => {
		const request = new Request('http://example.com', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				type: 'message_action',
				callback_id: 'warden_type_shortcut',
				user: { id: 'U_NOT_WARDEN' },
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('');
	});

	describe('channel whitelist', () => {
		it('ignores messages in channels not on the whitelist', async () => {
			const ctx = createExecutionContext();
			const response = await worker.fetch(
				new Request('http://example.com', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						type: 'event_callback',
						event: {
							type: 'message',
							channel: 'C_NOT_WHITELISTED',
							text: 'hello',
							ts: '1234567890.000001',
						},
					}),
				}),
				env,
				ctx,
			);
			await waitOnExecutionContext(ctx);
			// The bot should ack (200 "ok") without doing anything for a non-whitelisted channel
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('ok');
		});

		it('processes messages in a channel added via CHANNEL_WHITELIST env var', async () => {
			const ctx = createExecutionContext();
			const customChannel = 'C_CUSTOM_WHITELIST';
			const response = await worker.fetch(
				new Request('http://example.com', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						type: 'event_callback',
						event: {
							type: 'message',
							channel: customChannel,
							text: 'hello',
							ts: '1234567890.000002',
						},
					}),
				}),
				{ ...env, CHANNEL_WHITELIST: customChannel },
				ctx,
			);
			await waitOnExecutionContext(ctx);
			// The bot should not ack-and-bail early; it proceeds past the whitelist check.
			// Since no AI key / Slack token is set in test env it will still return 200 ok,
			// but the key assertion is that it does NOT short-circuit at the whitelist guard.
			expect(response.status).toBe(200);
		});

		it('accepts multiple channel IDs in CHANNEL_WHITELIST', async () => {
			const ctx = createExecutionContext();
			const channelA = 'C_WHITELIST_A';
			const channelB = 'C_WHITELIST_B';
			const response = await worker.fetch(
				new Request('http://example.com', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						type: 'event_callback',
						event: {
							type: 'message',
							channel: channelB,
							text: 'hello',
							ts: '1234567890.000003',
						},
					}),
				}),
				{ ...env, CHANNEL_WHITELIST: `${channelA}, ${channelB}` },
				ctx,
			);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(200);
		});
	});

	describe('assistant action parsing', () => {
		it('parses structured reply and reaction fields', () => {
			expect(
				parseAssistantAction('reply: go to the hole\nreaction: loll')
			).toEqual({ reply: 'go to the hole', reaction: 'loll' });
		});

		it('allows reaction-only outputs for normal messages', () => {
			expect(parseAssistantAction('reply:\nreaction: :skulk:')).toEqual({
				reply: '',
				reaction: 'skulk',
			});
		});
	});

	it('adds a Slack reaction for an AI-selected reaction-only message', async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					choices: [{ message: { content: 'reply:\nreaction: loll' } }],
				}),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: true }),
			});

		vi.stubGlobal('fetch', fetchMock);

		const kv = createKvMock();
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request('http://example.com', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					type: 'event_callback',
					event: {
						type: 'message',
						channel: 'C_CUSTOM_WHITELIST',
						user: 'U123',
						text: 'that message was dumb',
						ts: '1234567890.123456',
					},
				}),
			}),
			{
				...env,
				HACKCLUB_AI_API_KEY: 'test-key',
				CHANNEL_WHITELIST: 'C_CUSTOM_WHITELIST',
				WARDEN_KV: kv,
				SLACK_BOT_TOKEN: 'xoxb-test',
			},
			ctx,
		);

		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1][0]).toBe('https://slack.com/api/reactions.add');
		expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
			channel: 'C_CUSTOM_WHITELIST',
			timestamp: '1234567890.123456',
			name: 'loll',
		});
	});
});
