import { useRef, useState } from 'react';

export function useAgentRun() {
  const [streaming, setStreaming] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentStopping, setAgentStopping] = useState(false);
  const [_agentRunId, setAgentRunId] = useState(null);
  const [reconnectedRun, setReconnectedRun] = useState(false);
  const [agentTrace, setAgentTrace] = useState([]);
  const [pendingApproval, setPendingApproval] = useState(null);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [agentCollapsed, setAgentCollapsed] = useState(false);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [agentMobileTab, setAgentMobileTab] = useState('agent');
  const [pendingQuestion, setPendingQuestion] = useState(null);
  const [agentStartedAt, setAgentStartedAt] = useState(null);

  const agentRunIdRef = useRef(null);
  const agentAbortRef = useRef(null);
  const approvalRequestRef = useRef(null);
  const questionRequestRef = useRef(null);
  const touchStartRef = useRef(null);
  const reconnectTaskRef = useRef(null);
  const lastAgentTaskRef = useRef(null);

  return {
    streaming,
    setStreaming,
    agentRunning,
    setAgentRunning,
    agentStopping,
    setAgentStopping,
    _agentRunId,
    setAgentRunId,
    reconnectedRun,
    setReconnectedRun,
    agentTrace,
    setAgentTrace,
    pendingApproval,
    setPendingApproval,
    approvalSubmitting,
    setApprovalSubmitting,
    agentCollapsed,
    setAgentCollapsed,
    showMemoryPanel,
    setShowMemoryPanel,
    rollbackLoading,
    setRollbackLoading,
    agentMobileTab,
    setAgentMobileTab,
    pendingQuestion,
    setPendingQuestion,
    agentStartedAt,
    setAgentStartedAt,
    agentRunIdRef,
    agentAbortRef,
    approvalRequestRef,
    questionRequestRef,
    touchStartRef,
    reconnectTaskRef,
    lastAgentTaskRef,
  };
}
