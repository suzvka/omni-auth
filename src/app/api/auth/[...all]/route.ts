import { auth } from "@/lib/auth";
import { createRouteHandlers } from "changfeng-auth-nextjs";

export const { GET, POST } = createRouteHandlers(auth);
