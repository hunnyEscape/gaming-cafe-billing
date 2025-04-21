import * as path from 'path';
import * as dotenv from 'dotenv';

// .env.localファイルを読み込む
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import * as admin from 'firebase-admin';

// Firebase初期化
admin.initializeApp();

// 以下既存のコード

// セッション関連の関数をエクスポート
export { startSessionHttp } from './services/sessions/startSessionHttp';
export { endSessionHttp } from './services/sessions/endSessionHttp';
export { saveSessionJsonToBlockchain } from './services/sessions/saveSessionJsonToBlockchain';
export { unlockDoor } from './services/door/unlockDoor';
export { issueNewUserCoupon } from './services/coupons/issueNewUserCoupon';
export { generateMonthlyInvoices } from './services/invoices/generateMonthlyInvoices';
export { createStripeInvoiceHandler } from './services/invoices/createStripeInvoiceHandler';
export { updateInvoiceStatus } from './services/invoices/updateInvoiceStatus';