import { proxyAccountApi } from "@/features/auth/auth.proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = async (request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> => proxyAccountApi(request, (await context.params).path);
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
