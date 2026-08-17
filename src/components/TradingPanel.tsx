import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TradeForm } from "@/components/TradeForm";
import { EnhancedToken } from "@codex-data/sdk/dist/sdk/generated/graphql";
import { createKeypair } from "@/lib/solana";

interface TradingPanelProps {
  token: EnhancedToken
}

export function TradingPanel({ token }: TradingPanelProps) {
  const tokenSymbol = token.symbol;

  if (!import.meta.env.VITE_SOLANA_PRIVATE_KEY || !import.meta.env.VITE_HELIUS_RPC_URL || !import.meta.env.VITE_JUPITER_REFERRAL_ACCOUNT) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Trade {tokenSymbol || "Token"}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Trading requires VITE_SOLANA_PRIVATE_KEY, VITE_HELIUS_RPC_URL and VITE_JUPITER_REFERRAL_ACCOUNT to be configured in environment variables.
          </p>
        </CardContent>
      </Card>
    );
  }

  const keypair = createKeypair(import.meta.env.VITE_SOLANA_PRIVATE_KEY);
  const walletAddress = keypair.publicKey.toBase58();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Trade {tokenSymbol || "Token"}</CardTitle>
          <button
            onClick={() => {
              navigator.clipboard.writeText(walletAddress);
              toast.success("Wallet address copied!");
            }}
            className="text-xs text-muted-foreground font-mono hover:text-foreground transition-colors cursor-pointer"
          >
            {walletAddress.slice(0, 4)}...{walletAddress.slice(-4)}
          </button>
        </div>
      </CardHeader>
      <CardContent>
        <TradeForm token={token} />
      </CardContent>
    </Card>
  );
}
