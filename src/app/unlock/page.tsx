import { Suspense } from "react";
import { UnlockForm } from "@/components/UnlockForm";

export const metadata = {
  title: "ZenCub RAG - Internal Access",
};

export default function UnlockPage() {
  return (
    <Suspense>
      <UnlockForm />
    </Suspense>
  );
}
