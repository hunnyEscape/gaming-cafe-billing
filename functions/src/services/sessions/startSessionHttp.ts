import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { COLLECTIONS, SEAT_STATUS } from '../../config/constants';
import { SessionDocument, SeatDocument } from '../../types';

/**
 * セッション開始HTTP関数
 */
const GCF_API_KEY = functions.params.defineSecret('GCF_API_KEY');
export const startSessionHttp = functions.https.onRequest({ secrets: [GCF_API_KEY] }, async (req, res) => {
	// CORSヘッダー設定
	res.set('Access-Control-Allow-Origin', '*');
	res.set('Access-Control-Allow-Methods', 'GET, POST');
	res.set('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

	// OPTIONS（プリフライト）
	if (req.method === 'OPTIONS') {
		res.status(204).send('');
		return;
	}
	if (req.method !== 'POST') {
		res.status(405).json({ success: false, error: 'Please use POST.' });
		return;
	}
	if (req.headers['x-api-key'] !== GCF_API_KEY.value()) {
		res.status(401).json({ success: false, error: 'Invalid API‑Key' });
		return;
	}

	try {
		const { memberID, seatId } = req.body;
		if (!memberID || !seatId) {
			res.status(400).json({ success: false, error: 'memberID and seatId are required.' });
			return;
		}

		const db = admin.firestore();

		// memberIDでユーザーを検索（currentMemberIdまたはpreviousMemberId）
		const usersRef = db.collection(COLLECTIONS.USERS);
		const currentQuery = await usersRef.where('currentMemberId', '==', memberID).limit(1).get();

		let userDoc = null;
		let userId = '';

		if (!currentQuery.empty) {
			userDoc = currentQuery.docs[0];
			userId = userDoc.id;
		} else {
			// currentMemberIdで見つからない場合、previousMemberIdで検索
			const previousQuery = await usersRef.where('previousMemberId', '==', memberID).limit(1).get();

			if (!previousQuery.empty) {
				userDoc = previousQuery.docs[0];
				userId = userDoc.id;
			} else {
				res.status(404).json({ success: false, error: '有効な会員IDが見つかりません。' });
				return;
			}
		}

		// ユーザーIDが空でないことを確認（念のため）
		if (!userId) {
			res.status(500).json({ success: false, error: 'ユーザーIDの取得に失敗しました。' });
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
			const now = new Date(); // UTCのまま
			const startTime = admin.firestore.Timestamp.fromDate(now);

			const sessionData: SessionDocument = {
				sessionId,
				userId, // この時点でuserIdは空文字列ではないことが確認済み
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