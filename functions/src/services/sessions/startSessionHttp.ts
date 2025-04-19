import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { COLLECTIONS, SEAT_STATUS } from '../../config/constants';
import { SessionDocument, SeatDocument } from '../../types';

/**
 * セッション開始HTTP関数
 */
export const startSessionHttp = functions.https.onRequest(async (req, res) => {
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
		const { userId, seatId } = req.body;
		if (!userId || !seatId) {
			res.status(400).json({ success: false, error: 'userId and seatId are required.' });
			return;
		}

		const db = admin.firestore();
		const userDoc = await db.collection(COLLECTIONS.USERS).doc(userId).get();
		if (!userDoc.exists) {
			res.status(404).json({ success: false, error: 'User not found.' });
			return;
		}

		const seatRef = db.collection(COLLECTIONS.SEATS).doc(seatId);
		const seatDoc = await seatRef.get();
		if (!seatDoc.exists) {
			res.status(404).json({ success: false, error: 'Seat not found.' });
			return;
		}
		const seatData = seatDoc.data() as SeatDocument;
		if (seatData.status !== SEAT_STATUS.AVAILABLE) {
			res.status(409).json({ success: false, error: `Seat not available. Status: ${seatData.status}` });
			return;
		}

		const activeQuery = await db
			.collection(COLLECTIONS.SESSIONS)
			.where('seatId', '==', seatId)
			.where('active', '==', true)
			.limit(1)
			.get();
		if (!activeQuery.empty) {
			res.status(409).json({ success: false, error: 'An active session already exists.' });
			return;
		}

		const result = await db.runTransaction(async tx => {
			const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			// JST補正済 Timestamp を作成
			const now = new Date();
			const jstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000);
			const startTime = admin.firestore.Timestamp.fromDate(jstDate);

			const sessionData: SessionDocument = {
				sessionId,
				userId,
				seatId,
				startTime,
				endTime: '',
				pricePerHour: seatData.ratePerHour || 600,
				active: true,
				duration: 0,
				hourBlocks: 0,
				// Blockchainステータス
				blockchainStatus: 'pending',
				blockchainTxId: null,
				blockchainBlockNumber: null,
				blockchainConfirmedAt: null,
				blockchainChainId: null,
				blockchainNetworkId: null,
				blockchainErrorMessage: null,
			  };

			const sessionRef = db.collection(COLLECTIONS.SESSIONS).doc(sessionId);
			tx.set(sessionRef, sessionData);
			tx.update(seatRef, { status: SEAT_STATUS.IN_USE, updatedAt: admin.firestore.Timestamp.now() });

			return { sessionId, userId, seatId, startTime };
		});

		res.status(200).json({ success: true, message: 'Session started.', session: result });
	} catch (e) {
		functions.logger.error('startSessionHttp error:', e);
		res.status(500).json({ success: false, error: (e as Error).message });
	}
});
