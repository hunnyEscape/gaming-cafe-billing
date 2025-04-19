import { Request, Response } from 'express';
import * as admin from 'firebase-admin';
import axios from 'axios';
import { aesCmac } from 'node-aes-cmac';
import * as functions from 'firebase-functions';

const db = admin.firestore();

/* ── Secret の定義 ───────────────────────── */
const GCF_API_KEY = functions.params.defineSecret('GCF_API_KEY');
const SESAME_API_KEY = functions.params.defineSecret('SESAME_API_KEY');
const SESAME_DEVICE_UUID = functions.params.defineSecret('SESAME_DEVICE_UUID');
const SESAME_DEVICE_SECRET = functions.params.defineSecret('SESAME_DEVICE_SECRET_KEY');

/* ── ハンドラ ─────────────────────────────── */
const unlockDoorHandler = async (req: Request, res: Response): Promise<void> => {
	res.set('Access-Control-Allow-Origin', '*');
	if (req.method === 'OPTIONS') {
		res.set('Access-Control-Allow-Methods', 'POST');
		res.set('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
		res.set('Access-Control-Max-Age', '3600');
		res.status(204).send('');
		return;
	}
	if (req.method !== 'POST') {
		res.status(405).json({ success: false, message: 'Use POST' });
		return;
	}

	/* --- API‑Key 認証 --- */
	if (req.headers['x-api-key'] !== GCF_API_KEY.value()) {
		res.status(401).json({ success: false, message: 'Invalid API‑Key' });
		return;
	}

	/* --- userId (= code) --- */
	const { code } = req.body as { code?: string };
	if (!code) {
		res.status(400).json({ success: false, message: 'QRコードが必要です' });
		return;
	}

	try {
		const snap = await db.collection('users').doc(code).get();
		if (!snap.exists) {
			res.status(404).json({ success: false, message: 'ユーザーが見つかりません' });
			return;
		}
		const user = snap.data()!;
		if (!user.registrationCompleted) {
			res.status(403).json({ success: false, message: '登録が完了していません' });
			return;
		}

		/* --- SESAME 解錠 --- */
		await unlockSesame(user.email || 'Firestore User');

		/* --- ログ保存 --- */
		await logAccess(code, user.email);

		res.status(200).json({ success: true, message: 'ドアの解錠に成功しました' });
	} catch (err: any) {
		console.error('unlockDoor error:', err);
		res.status(500).json({ success: false, message: err.message });
	}
};

/* ── 関数エクスポート（Secretsひも付け） ───────── */
export const unlockDoor = functions
	.https
	.onRequest(
		{
			secrets: [GCF_API_KEY, SESAME_API_KEY, SESAME_DEVICE_UUID, SESAME_DEVICE_SECRET]
		},
		unlockDoorHandler
	);

/* ── Helpers ─────────────────────────────── */
async function unlockSesame(history: string) {
	const cmd = 88;
	const sign = generateSign(SESAME_DEVICE_SECRET.value());

	await axios.post(
		`https://app.candyhouse.co/api/sesame2/${SESAME_DEVICE_UUID.value()}/cmd`,
		{ cmd, history: Buffer.from(history).toString('base64'), sign },
		{ headers: { 'x-api-key': SESAME_API_KEY.value() } }
	);
}

function generateSign(secret: string): string {
	const key = Buffer.from(secret, 'hex');
	const time = Math.floor(Date.now() / 1000);
	const buf = Buffer.allocUnsafe(4);
	buf.writeUInt32LE(time);
	return aesCmac(key, buf.slice(1));   // 3 byte
}

async function logAccess(userId: string, email: string) {
	await db.collection('accessLogs').add({
		userId,
		email,
		timestamp: admin.firestore.FieldValue.serverTimestamp(),
		action: 'unlock'
	});
}
