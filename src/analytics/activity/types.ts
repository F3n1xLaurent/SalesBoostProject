export type ActivityRole = 'employee' | 'company_admin' | 'branch_admin';
export type Scope = {
  period: 7 | 30 | 90;
  companyId: string | null;
  branchId: string | null;
};
export type Status = 'active' | 'fading' | 'inactive' | 'not_started';
export type NsValue = {
  value: number | null;
  state: 'ok' | 'insufficient';
};
export type Company = {
  id: string;
  name: string;
  createdAt: Date;
  hasCallPlan: boolean;
};
export type Branch = {
  id: string;
  name: string;
  companyId: string;
  createdAt: Date;
};
export type Person = {
  accountId: string;
  role: ActivityRole;
  companyId: string;
  branchId: string | null;
  createdAt: Date;
};
export type Employee = {
  id: string;
  accountId: string;
  branchId: string;
  companyId: string;
};
export type Event = {
  accountId: string;
  role: ActivityRole;
  companyId: string;
  branchId: string | null;
  eventName: string;
  date: string;
  reportType: string | null;
  section: string | null;
  actions: number;
  lastAt: Date;
};
export type Training = {
  id: string;
  accountId: string;
  companyId: string;
  branchId: string | null;
  status: string;
  score: number | null;
  failureReason: string | null;
  sessionType: string;
  difficulty: string;
  durationSec: number | null;
  startedAt: Date;
  completedAt: Date | null;
};
export type Call = {
  id: string;
  companyId: string;
  branchId: string;
  scriptId: string | null;
  startedAt: Date;
  connectedAt: Date | null;
  outcome: string | null;
  score: number | null;
  talkDurationSec: number | null;
  durationSec: number | null;
};
export type DailyPlan = {
  accountId: string;
  companyId: string;
  branchId: string | null;
  date: string;
  items: {
    status?: string;
  }[];
};
export type Sources = {
  companies: Company[];
  branches: Branch[];
  people: Person[];
  employees: Employee[];
  events: Event[];
  trainings: Training[];
  calls: Call[];
  plans: DailyPlan[];
  streaks: {
    accountId: string;
    branchId: string;
    current: number;
    date: string | null;
  }[];
  lastActions: {
    companyId: string;
    branchId: string | null;
    at: Date;
  }[];
};
export type RoleBlock = {
  active: number;
  total: number;
  notVisited: number;
  activeDaysPerWeek: number | null;
  features: {
    key: string;
    label: string;
    people: number;
    actions: number;
  }[];
};
export type Count = {
  value: number;
  total: number;
  delta: number | null;
};
export type ActivityResponse = {
  generatedAt: string;
  periodDays: 7 | 30 | 90;
  scope: {
    view: 'all' | 'company' | 'branch';
    companyId: string | null;
    branchId: string | null;
  };
  filters: {
    companies: {
      id: string;
      name: string;
    }[];
    branches: {
      id: string;
      name: string;
      companyId: string;
    }[];
  };
  kpis: {
    activeEntities: Count | null;
    branchStatus: {
      status: Status;
      lastActionAt: string | null;
    } | null;
    activeLeaders: Count;
    activeEmployees: Count;
    answerRate: {
      connected: number;
      launched: number;
      rate: number | null;
      deltaPp: number | null;
    };
    northStar: {
      value: number | null;
      delta: number | null;
      branchesWithData: number;
    };
  };
  dailyActive: {
    granularity: 'day' | 'week';
    points: {
      date: string;
      leaders: number;
      employees: number;
    }[];
  };
  table: {
    kind: 'companies' | 'branches';
    rows: {
      id: string;
      name: string;
      status: Status;
      lastActionAt: string | null;
      branchesCount?: number;
      employeesTotal?: number;
      activeLeaders: number;
      activeEmployees: number;
      callsLaunched: number;
      answerRate: number | null;
      trainingsStarted: number;
      northStar: NsValue;
    }[];
  };
  roles: {
    leaders: RoleBlock;
    employees: RoleBlock & {
      reports: Record<'viewed' | 'findings' | 'recommendations', {
        training: number;
        call: number;
      }>;
    };
  };
  trainer: {
    outcomes: {
      evaluated: number;
      failCase: number;
      abandoned: number;
      failed: number;
    };
    byType: {
      plan: number;
      free: number;
    };
    byDifficulty: {
      easy: number;
      medium: number;
      hard: number;
    };
    trainedPeople: number;
    perPerson: number | null;
    dailyPlanCompletionRate: number | null;
    streakPeople: number;
    avgDurationSec: number | null;
    openedNotStarted: number;
  };
  calls: {
    funnel: {
      launched: number;
      connected: number;
      talked: number;
      evaluated: number;
    };
    outcomes: {
      completed: number;
      disconnected: number;
      no_answer: number;
      busy: number;
      failed: number;
    };
    avgTalkSec: number | null;
    branchesWithoutCalls: number;
    notEvaluated: number;
  };
  value: {
    groups: {
      improved: number;
      flat: number;
      declined: number;
      insufficient: number;
    };
    series: {
      date: string;
      value: number | null;
    }[];
    trainedVsNot: {
      trained: NsValue & {
        branches: number;
      };
      notTrained: NsValue & {
        branches: number;
      };
    };
  };
  sections: {
    leaders: {
      section: string;
      label: string;
      people: number;
    }[];
    employees: {
      section: string;
      label: string;
      people: number;
    }[];
  };
};
