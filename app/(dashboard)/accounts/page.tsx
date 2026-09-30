import type { Metadata } from "next";
import { AccountsView } from "@/components/dashboard/views/accounts-view";

export const metadata: Metadata = { title: "Accounts" };

export default function AccountsPage() {
  return <AccountsView />;
}
