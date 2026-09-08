import { LandingPage } from "./components/LandingPage";
import { useRentGroup } from "./hooks/useRentGroup";
import { lazy, Suspense, useEffect, useState } from "react";

const KvaraChatWorkspace = lazy(() => import("./components/KvaraChatWorkspace").then((module) => ({
  default: module.KvaraChatWorkspace
})));
const ProofPage = lazy(() => import("./components/ProofPage").then((module) => ({ default: module.ProofPage })));

export default function App() {
  if (window.location.pathname.replace(/\/$/, "") === "/proof") {
    return <WorkspaceFallback><ProofPage /></WorkspaceFallback>;
  }
  return <RentApp />;
}

function RentApp() {
  const [view, setView] = useState<"landing" | "app">(() =>
    window.location.hash === "#app" ? "app" : "landing"
  );
  const {
    activeGroup,
    createGroup,
    updateRoommatePermission,
    deleteGroup,
    loadGroupsForWallet,
    resetWallet,
    inviteRoommate,
    isInvite,
    history,
    mergePaymentRecords,
    applyCommands,
    stats
  } = useRentGroup();

  useEffect(() => {
    function syncView() {
      setView(window.location.hash === "#app" ? "app" : "landing");
    }

    window.addEventListener("hashchange", syncView);
    return () => window.removeEventListener("hashchange", syncView);
  }, []);

  function enterApp() {
    if (window.location.hash !== "#app") {
      window.location.hash = "app";
    }
    setView("app");
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  if (isInvite) {
    return (
      <WorkspaceFallback>
        <KvaraChatWorkspace
          group={activeGroup}
          inviteRoommate={inviteRoommate}
          isInvite={isInvite}
          history={history}
          stats={stats}
          onCreate={createGroup}
          onPermissionGranted={updateRoommatePermission}
          onDeleteGroup={deleteGroup}
          onWalletConnected={loadGroupsForWallet}
          onWalletDisconnected={resetWallet}
          onPaymentsUpdated={mergePaymentRecords}
          onCommands={applyCommands}
        />
      </WorkspaceFallback>
    );
  }

  if (view === "landing") {
    return <LandingPage onEnterApp={enterApp} />;
  }

  return (
    <WorkspaceFallback>
      <KvaraChatWorkspace
        group={activeGroup}
        inviteRoommate={inviteRoommate}
        isInvite={isInvite}
        history={history}
        stats={stats}
        onCreate={createGroup}
        onPermissionGranted={updateRoommatePermission}
        onDeleteGroup={deleteGroup}
        onWalletConnected={loadGroupsForWallet}
        onWalletDisconnected={resetWallet}
        onPaymentsUpdated={mergePaymentRecords}
        onCommands={applyCommands}
      />
    </WorkspaceFallback>
  );
}

function WorkspaceFallback({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={(
      <main className="grid min-h-screen place-items-center bg-[#f4efe5] text-stone-950" aria-busy="true">
        <span className="font-display text-3xl">Kvara</span>
      </main>
    )}>
      {children}
    </Suspense>
  );
}
