import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import { ethers } from 'ethers';
import { COLLECTIONS, CHAIN_CONFIG } from '../../config/constants';
import { SessionDocument } from '../../types';

/**
 * セッション更新トリガー → ブロックチェーン埋め込み
 */
export const saveSessionHashToBlockchain = functions.firestore
	.document(`${COLLECTIONS.SESSIONS}/{sessionId}`)
	.onUpdate(async (change, context) => {
		const before = change.before.data() as Partial<SessionDocument>;
		const after = change.after.data() as SessionDocument;
		const sessionId = context.params.sessionId;

		// ステータス遷移確認: pending で txId 未セット → 処理開始
		if (
			before.blockchainStatus === 'pending' &&
			after.blockchainStatus === 'pending' &&
			!after.blockchainTxId
		) {
			const db = admin.firestore();
			const sessionRef = db.collection(COLLECTIONS.SESSIONS).doc(sessionId);

			try {
				// Provider & Wallet 初期化
				const privateKey = functions.config().avalanche?.privatekey;
				if (!privateKey) throw new Error('Avalanche private key not configured');
				const provider = new ethers.providers.JsonRpcProvider(CHAIN_CONFIG.RPC_ENDPOINT);
				const wallet = new ethers.Wallet(privateKey, provider);

				// データペイロード作成
				//const payload = JSON.stringify({
				//	sessionId,
				//	hash: after.jsonHash,
				//	timestamp: Date.now(),
				//});
				//const payload = after.jsonHash;
				// トランザクション送信
				const payload = after.jsonHash.startsWith('0x') ? after.jsonHash : '0x' + after.jsonHash;
				const tx = await wallet.sendTransaction({
					to: wallet.address,
					value: ethers.utils.parseEther('0'),
					data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes(payload)),
					gasLimit: 100000,
				});

				// 1ブロック確認
				const receipt = await tx.wait(1);

				// 成功時、Session を更新
				await sessionRef.update({
					blockchainStatus: 'confirmed',
					blockchainTxId: receipt.transactionHash,
					blockchainBlockNumber: receipt.blockNumber,
					blockchainConfirmedAt: admin.firestore.Timestamp.now(),
					blockchainChainId: CHAIN_CONFIG.CHAIN_ID,
					blockchainNetworkId: CHAIN_CONFIG.NETWORK_ID,
				});

				return { success: true };
			} catch (error) {
				// エラー時、Session を更新
				await sessionRef.update({
					blockchainStatus: 'error',
					blockchainErrorMessage: error instanceof Error ? error.message : String(error),
					blockchainConfirmedAt: admin.firestore.Timestamp.now(),
				});
				throw error;
			}
		}
		return null;
	});
