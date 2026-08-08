import { auth } from "@/lib/auth";
import { createRouteHandlers } from "omni-auth-nextjs";

export const { GET, POST } = createRouteHandlers(auth);
