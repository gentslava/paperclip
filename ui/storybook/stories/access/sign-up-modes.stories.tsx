import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AuthSignUpMode } from "@paperclipai/shared";
import { AuthPage } from "@/pages/Auth";
import { queryKeys } from "@/lib/queryKeys";

function SignInPage({ mode }: { mode: AuthSignUpMode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(queryKeys.health, { status: "ok", deploymentMode: "authenticated", authSignUpMode: mode });
  client.setQueryData(queryKeys.auth.session, null);
  return (
    <QueryClientProvider client={client}>
      <AuthPage />
    </QueryClientProvider>
  );
}

const meta: Meta<typeof SignInPage> = {
  id: "auth-sign-up-modes",
  title: "Getting started and access/Login, invitations, and access/Sign-up modes",
  component: SignInPage,
  parameters: {
    layout: "fullscreen",
    paperclip: {
      capabilities: ["access/login"],
      status: "unreviewed",
      implementation: "production",
      boundary: "fixtures",
      notes: "AuthPage registration modes use cached health/session fixtures; live authentication and invitation acceptance remain separate.",
    },
  },
};

export default meta;
type Story = StoryObj<typeof SignInPage>;

/** `PAPERCLIP_AUTH_SIGN_UP=open` (default): the sign-in page offers "Create one". */
export const Open: Story = { args: { mode: "open" } };

/** `PAPERCLIP_AUTH_SIGN_UP=invite`: no sign-up form; invited people register from the invite link. */
export const InviteOnly: Story = { args: { mode: "invite" } };

/** `PAPERCLIP_AUTH_SIGN_UP=disabled`: registration is closed. */
export const Closed: Story = { args: { mode: "disabled" } };
