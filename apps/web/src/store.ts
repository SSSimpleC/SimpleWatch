import { create } from "zustand";

interface SessionState {
  account: { id: string; username: string; role: "host" | "viewer" } | null;
  adminCsrf: string | null;
  roomCsrf: string | null;
  memberId: string | null;
  setAdminCsrf(value: string | null): void;
  setRoomCsrf(value: string | null): void;
  setMemberId(value: string | null): void;
  setAccount(value: SessionState["account"]): void;
  clear(): void;
}

export const useSession = create<SessionState>((set) => ({
  account: null,
  adminCsrf: null,
  roomCsrf: null,
  memberId: null,
  setAdminCsrf: (adminCsrf) => set({ adminCsrf, roomCsrf: adminCsrf }),
  setRoomCsrf: (roomCsrf) => set({ roomCsrf, adminCsrf: roomCsrf }),
  setMemberId: (memberId) => set({ memberId }),
  setAccount: (account) => set({ account }),
  clear: () =>
    set({ account: null, adminCsrf: null, roomCsrf: null, memberId: null }),
}));
