import { streamText } from 'ai';
import { bufferText } from './utils';
import { DurableObject } from 'cloudflare:workers';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import PQueue from 'p-queue';

/* Todo
 * ✅ 1. WS with frontend
 * ✅ 2. Get audio to backend
 * ✅ 3. Convert audio to text
 * ✅ 4. Run inference
 * ✅ 5. Convert result to audio
 * ✅ 6. Send audio to frontend
 */

export class MyDurableObject extends DurableObject {
	env: Env;
	msgHistory: Array<{ role: 'user' | 'assistant' | 'system', content: string }>;
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.env = env;
		this.msgHistory = [];
	}
	async fetch(request: any) {
		// set up ws pipeline
		const webSocketPair = new WebSocketPair();
		const [socket, ws] = Object.values(webSocketPair);

		ws.accept();
		// Initialize Google Generative AI provider (AI Studio API key)
		const google = createGoogleGenerativeAI({ apiKey: this.env.GOOGLE_API_KEY });
		// Serialize TTS to avoid overlapping audio
		const ttsQueue = new PQueue({ concurrency: 1 });

		// Config
		const MAX_HISTORY = 12; // cap convo memory
		const HEARTBEAT_MS = 25000; // CF edge websockets timeouts are aggressive; send pings periodically
		const REQUEST_TIMEOUT_MS = 20000; // external API timeout

		let closed = false;

		const safeSend = (obj: any) => {
			if (closed) return;
			try {
				ws.send(JSON.stringify(obj));
			} catch (err) {
				console.error('WS send failed', err);
			}
		};

		// Heartbeat ping to keep the connection alive
		const heartbeat = setInterval(() => {
			safeSend({ type: 'ping', t: Date.now() });
		}, HEARTBEAT_MS);

		const abortableFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const ac = new AbortController();
			const id = setTimeout(() => ac.abort('timeout'), REQUEST_TIMEOUT_MS);
			try {
				return await fetch(input, { ...init, signal: ac.signal });
			} finally {
				clearTimeout(id);
			}
		};

		ws.addEventListener('message', async (event) => {
			// handle chat commands
			if (typeof event.data === 'string') {
				try {
					const parsed = JSON.parse(event.data);
					const { type, data } = parsed ?? {};
					if (type === 'cmd') {
						if (data === 'clear') {
							this.msgHistory.length = 0; // clear chat history
							safeSend({ type: 'ok', cmd: 'clear' });
						}
						return; // end processing here for this event type
					}
					return; // ignore unknown string frames
				} catch (_e) {
					// ignore plain text messages
					return;
				}
			}

			// transcribe audio buffer to text (Deepgram STT - prerecorded)
			let text = '';
			try {
				const dgResp = await abortableFetch('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true', {
					method: 'POST',
					headers: {
						Authorization: `Token ${this.env.DEEPGRAM_API_KEY}`,
						'Content-Type': 'audio/wav',
					},
					// Forward the raw WAV bytes from the client
					body: event.data as ArrayBuffer,
				});
				if (!dgResp.ok) {
					const errTxt = await dgResp.text().catch(() => '');
					throw new Error(`Deepgram error ${dgResp.status}: ${errTxt}`);
				}
				const dgJson: any = await dgResp.json();
				text = dgJson?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
			} catch (err) {
				console.error('Deepgram transcription failed:', err);
				text = '';
			}
			console.log('>>', text);
			safeSend({ type: 'text', text }); // send transcription to client
			if (!text || !text.trim()) {
				return; // nothing to respond to
			}
			this.msgHistory.push({ role: 'user', content: text });
			// trim history to cap
			if (this.msgHistory.length > MAX_HISTORY) this.msgHistory.splice(0, this.msgHistory.length - MAX_HISTORY);

			// run inference (Google Generative AI)
			const result = streamText({
				model: google('gemini-2.5-flash-lite'),
				system: 'You are in a voice conversation with the user. Be concise and helpful.',
				messages: this.msgHistory,
			});
			// buffer streamed response into sentences, then convert to audio
			await bufferText(result.textStream as any, async (sentence: string) => {
				this.msgHistory.push({ role: 'assistant', content: sentence });
				console.log('<<', sentence);
				if (this.msgHistory.length > MAX_HISTORY) this.msgHistory.splice(0, this.msgHistory.length - MAX_HISTORY);
				await ttsQueue.add(async () => {
					// convert response to audio using Deepgram TTS
					try {
						const url = new URL('https://api.deepgram.com/v1/speak');
						url.searchParams.set('model', 'aura-2-thalia-en');
						url.searchParams.set('encoding', 'linear16');
						url.searchParams.set('container', 'wav');

						const resp = await abortableFetch(url.toString(), {
							method: 'POST',
							headers: {
								Authorization: `Token ${this.env.DEEPGRAM_API_KEY}`,
								'Content-Type': 'application/json',
							},
							body: JSON.stringify({ text: sentence }),
						});
						if (!resp.ok) {
							const errTxt = await resp.text().catch(() => '');
							throw new Error(`Deepgram TTS error ${resp.status}: ${errTxt}`);
						}
						const audioBuffer = await resp.arrayBuffer();
						// encode binary to base64 for transport over WS (single frame expected by client)
						const bytes = new Uint8Array(audioBuffer);
						let binary = '';
						const innerChunk = 0x8000; // avoid call stack limits
						for (let j = 0; j < bytes.length; j += innerChunk) {
							binary += String.fromCharCode(...bytes.subarray(j, Math.min(j + innerChunk, bytes.length)));
						}
						const b64 = btoa(binary);
						safeSend({ type: 'audio', text: sentence, audio: b64 });
					} catch (e) {
						console.error('Deepgram TTS failed:', e);
					}
				});
			});
		});

		ws.addEventListener('close', (cls) => {
			closed = true;
			try { clearInterval(heartbeat); } catch {}
			try { ws.close(cls.code, 'Durable Object is closing WebSocket'); } catch {}
		});

		return new Response(null, { status: 101, webSocket: socket });
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (request.url.endsWith('/websocket')) {
			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				return new Response('Expected upgrade to websocket', { status: 426 });
			}
			// Sticky session per client: one DO per connection
			let id: DurableObjectId = env.MY_DURABLE_OBJECT.idFromName(crypto.randomUUID());
			let stub = env.MY_DURABLE_OBJECT.get(id);
			return stub.fetch(request);
		}

		return new Response(null, {
			status: 400,
			statusText: 'Bad Request',
			headers: { 'Content-Type': 'text/plain' },
		});
	},
} satisfies ExportedHandler<Env>;
