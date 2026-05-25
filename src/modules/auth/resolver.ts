import type { Account } from "./types";

export type AccountResolver = {
  findByAuthUserId(authUserId: string): Promise<Account | null>;
};

let registeredResolver: AccountResolver | null = null;

export function setAccountResolver(resolver: AccountResolver): void {
  registeredResolver = resolver;
}

export function getAccountResolver(): AccountResolver | null {
  return registeredResolver;
}
