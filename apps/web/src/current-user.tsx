import { MeResponseSchema, type User } from "@factorylens/contracts";

export const currentUserQueryKey = ["current-user"] as const;

export class CurrentUserRequestError extends Error {
  constructor(readonly status: number) {
    super("Current user request failed");
  }
}

export async function fetchCurrentUser(): Promise<User> {
  const response = await fetch("/api/me");
  if (!response.ok) throw new CurrentUserRequestError(response.status);
  return MeResponseSchema.parse(await response.json()).user;
}

function initials(displayName: string): string {
  return displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toLocaleUpperCase();
}

export function UserAvatar({
  className,
  user,
}: {
  className: string;
  user: User | null;
}) {
  return user?.avatarUrl ? (
    <img
      alt=""
      aria-hidden="true"
      className={className}
      referrerPolicy="no-referrer"
      src={user.avatarUrl}
    />
  ) : (
    <span aria-hidden="true" className={className}>
      {user ? initials(user.displayName) : "…"}
    </span>
  );
}
