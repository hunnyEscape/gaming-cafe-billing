import { Timestamp } from 'firebase-admin/firestore';

export interface User {
  userId: string;
  displayName: string;
  email: string;
  memberUUID: string;
  membershipType?: string;
  totalUsageMinutes?: number;
}

export interface Seat {
  seatId: string;
  name: string;
  macAddress?: string;
  ipAddress?: string;
  status: string;
  ratePerMinute: number;
  lastMaintenanceAt?: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Session {
  sessionId: string;
  userId: string;
  seatId: string;
  startTime: Timestamp;
  endTime: Timestamp | null;
  durationMinutes: number;
  pricePerMinute: number;
  amount: number;
  active: boolean;
  billingId: string | null;
}

export interface BillingProof {
  billingId: string;
  userId: string;
  sessionId: string;
  seatId: string;
  fileUrl: string;
  hash: string;
  chainId: string;
  networkId: number;
  txId: string | null;
  blockNumber: number | null;
  status: string;
  createdAt: Timestamp;
  confirmedAt: Timestamp | null;
}

export interface BillingQueueItem {
  sessionId: string;
  userId: string;
  seatId: string;
  status: string;
  createdAt: Timestamp;
  billingId?: string;
  hashValue?: string;
  updatedAt?: Timestamp;
  errorMessage?: string;
}