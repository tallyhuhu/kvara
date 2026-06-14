import { KvaraChatWorkspace } from "./components/KvaraChatWorkspace";
import { LandingPage } from "./components/LandingPage";
import { useRentGroup } from "./hooks/useRentGroup";
import { useEffect, useState } from "react";

export default function App() {
  const [view, setView] = useState<"landing" | "app">(() =>
    window.location.hash === "#app" ? "app" : "landing"
  );
  const {
    activeGroup,
    createGroup,
    updateRoommatePermission,
    deleteGroup,
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
      <KvaraChatWorkspace
        group={activeGroup}
        inviteRoommate={inviteRoommate}
        isInvite={isInvite}
        history={history}
        stats={stats}
        onCreate={createGroup}
        onPermissionGranted={updateRoommatePermission}
        onDeleteGroup={deleteGroup}
        onPaymentsUpdated={mergePaymentRecords}
        onCommands={applyCommands}
      />
    );
  }

  if (view === "landing") {
    return <LandingPage onEnterApp={enterApp} />;
  }

  return (
    <KvaraChatWorkspace
      group={activeGroup}
      inviteRoommate={inviteRoommate}
      isInvite={isInvite}
      history={history}
      stats={stats}
      onCreate={createGroup}
      onPermissionGranted={updateRoommatePermission}
      onDeleteGroup={deleteGroup}
      onPaymentsUpdated={mergePaymentRecords}
      onCommands={applyCommands}
    />
  );
}
