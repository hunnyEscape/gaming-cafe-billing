import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { COLLECTIONS, SEAT_STATUS } from '../../config/constants';
import { SessionDocument } from '../../types';

/**
 * セッション終了HTTP関数
 */
export const endSessionHttp = functions.https.onRequest(async (req, res) => {
	// CORSヘッダー設定
	res.set('Access-Control-Allow-Origin', '*');
	res.set('Access-Control-Allow-Methods', 'GET, POST');
	res.set('Access-Control-Allow-Headers', 'Content-Type');

	// OPTIONS（プリフライト）
	if (req.method === 'OPTIONS') {
		res.status(204).send('');
		return;
	}
	if (req.method !== 'POST') {
		res.status(405).json({ success: false, error: 'Please use POST.' });
		return;
	}

	try {
		const { sessionId, seatId } = req.body;
		if (!sessionId && !seatId) {
			res.status(400).json({ success: false, error: 'sessionId or seatId is required.' });
			return;
		}

		const db = admin.firestore();
		let ref = sessionId
			? db.collection(COLLECTIONS.SESSIONS).doc(sessionId)
			: (await db
				.collection(COLLECTIONS.SESSIONS)
				.where('seatId', '==', seatId)
				.where('active', '==', true)
				.limit(1)
				.get()).docs[0].ref;

		const snap = await ref.get();
		if (!snap.exists) {
			res.status(404).json({ success: false, error: 'Session not found.' });
			return;
		}
		const data = snap.data() as SessionDocument;
		if (!data.active) {
			res.status(409).json({ success: false, error: 'Session already ended.' });
			return;
		}

		const result = await db.runTransaction(async tx => {
			// JST補正済 Timestamp
			const now = new Date();
			const jstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000);
			const endTime = admin.firestore.Timestamp.fromDate(jstDate);

			const startMs = (data.startTime as admin.firestore.Timestamp).toMillis();
			const duration = Math.ceil((endTime.toMillis() - startMs) / 1000);  // 秒単位
			const hourBlocks = Math.ceil(duration / 3600);  

			tx.update(ref, { endTime, duration, hourBlocks, active: false });
			tx.update(db.collection(COLLECTIONS.SEATS).doc(data.seatId), {
				status: SEAT_STATUS.AVAILABLE,
				updatedAt: admin.firestore.Timestamp.now()
			});
			tx.set(db.collection(COLLECTIONS.BILLING_QUEUE).doc(), {
				sessionId: data.sessionId,
				userId: data.userId,
				seatId: data.seatId,
				status: 'pending',
				createdAt: admin.firestore.Timestamp.now()
			});

			return { sessionId: data.sessionId, userId: data.userId, seatId: data.seatId, startTime: data.startTime, endTime, duration, hourBlocks };
		});

		res.status(200).json({ success: true, message: 'Session ended.', session: result });
	} catch (e) {
		functions.logger.error('endSessionHttp error:', e);
		res.status(500).json({ success: false, error: (e as Error).message });
	}
});
