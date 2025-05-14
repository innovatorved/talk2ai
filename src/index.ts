import { streamText } from 'ai';
import { bufferText } from './utils';
import { DurableObject } from 'cloudflare:workers';
import { createWorkersAI } from 'workers-ai-provider';
import toUint from 'base64-to-uint8array';

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
	msgHistory: Array<Object>;
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.env = env;
		this.msgHistory = [];
	}
	async fetch(request: any) {
		const webSocketPair = new WebSocketPair();
		const [socket, ws] = Object.values(webSocketPair);

		ws.accept();
		const workersai = createWorkersAI({ binding: this.env.AI });
		const model = workersai('@cf/meta/llama-3.3-70b-instruct-fp8-fast');

		ws.addEventListener('message', async (event) => {
			const input = {
				audio: [...new Uint8Array(event.data as ArrayBuffer)],
			};

			const { text } = await this.env.AI.run('@cf/openai/whisper-tiny-en', input);
			ws.send(JSON.stringify({ type: 'text', text }));
			console.log('>> ', text);
			this.msgHistory.push({ role: 'user', content: text });

			console.log(this.msgHistory);
			const { textStream } = streamText({
				model,
				system: 'You in a voice conversation with the user',
				messages: this.msgHistory as any,
			});

			// buffer streamed response into sentences, then convert to audio
			await bufferText(textStream, async (sentence: string) => {
				console.log('>>', sentence);
				this.msgHistory.push({ role: 'assistant', content: sentence });
				const audio = await this.env.AI.run('@cf/myshell-ai/melotts' as any, {
					prompt: sentence,
				});
				ws.send(JSON.stringify({ type: 'audio', text: sentence, audio: audio.audio }));
			});
		});

		ws.addEventListener('close', (cls) => {
			ws.close(cls.code, 'Durable Object is closing WebSocket');
		});

		return new Response(null, {
			status: 101,
			webSocket: socket,
		});
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (request.url.endsWith('/websocket')) {
			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				return new Response('Durable Object expected Upgrade: websocket', {
					status: 426,
				});
			}
			let id: DurableObjectId = env.MY_DURABLE_OBJECT.idFromName(new URL(request.url).pathname);
			let stub = env.MY_DURABLE_OBJECT.get(id);
			return stub.fetch(request);
		}

		return new Response(null, {
			status: 400,
			statusText: 'Bad Request',
			headers: {
				'Content-Type': 'text/plain',
			},
		});
	},
} satisfies ExportedHandler<Env>;
