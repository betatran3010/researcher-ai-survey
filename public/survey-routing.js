// public/survey-routing.js
// ---------------------------------------------------------------------------
// Pure page-order + section-numbering logic for the Research Scholars survey,
// extracted so it can be unit-tested in Node (test/frontend-routing.test.js)
// AND used unchanged in the browser. No DOM access, no globals, no side
// effects — everything is derived from its arguments.
//
// This module ONLY decides ordering and section numbers. It does not change
// any participant-facing wording, questions, or design.
//
// Two placement conditions:
//
//   CT-before ("pre"):
//     Consent -> About You -> SRL
//       -> CT without AI (page-ct)
//       -> AI-use gate (page-ai-use-gate)
//       -> AI experience (page-ai-experience)        [only if prior AI use]
//       -> CT with AI (page-ai-evaluation)           [only if prior AI use]
//       -> instruction pages -> one-paper task (page-study-1)
//       -> quiz intro + quiz -> Debrief -> Submitted
//     Key requirement: page-ct comes BEFORE any explicit AI-use question.
//
//   CT-after ("post"):
//     Consent -> About You -> SRL
//       -> AI-use gate (page-ai-use-gate)
//       -> AI experience (page-ai-experience)        [only if prior AI use]
//       -> instruction pages -> one-paper task (page-study-1)
//       -> quiz intro + quiz
//       -> CT without AI (page-ct)
//       -> CT with AI (page-ai-evaluation)           [only if prior AI use]
//       -> Debrief -> Submitted
//     Key requirement: the assigned-paper quiz immediately follows the task,
//     BEFORE either CT page.
//
// AI-evaluation (CT with AI) eligibility is based ONLY on prior research AI use
// (hasAiUse), never on the assigned experimental condition or whether the
// participant messaged the AI assistant.
// ---------------------------------------------------------------------------
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SurveyRouting = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Build the ordered list of page ids for the given placement / prior-AI-use
  // branch. instructionIds and quizIds are spliced in exactly where they
  // belong (they are built dynamically elsewhere; pass [] before they exist).
  function computePageOrder(placement, hasAiUse, instructionIds, quizIds) {
    const pre = placement === 'pre';
    const instr = Array.isArray(instructionIds) ? instructionIds : [];
    const quiz = Array.isArray(quizIds) ? quizIds : [];

    const order = ['page-consent', 'page-about-you', 'page-srl'];

    if (pre) {
      // CT without AI must appear before any explicit AI-use question.
      order.push('page-ct');
      order.push('page-ai-use-gate');
      if (hasAiUse) order.push('page-ai-experience');
      if (hasAiUse) order.push('page-ai-evaluation'); // CT with AI
    } else {
      order.push('page-ai-use-gate');
      if (hasAiUse) order.push('page-ai-experience');
    }

    if (instr.length > 0) order.push.apply(order, instr);
    order.push('page-study-1');

    // Quiz immediately follows the task/instruction sequence.
    order.push('page-quiz-intro');
    if (quiz.length > 0) order.push.apply(order, quiz);

    if (!pre) {
      // In the post condition the CT pages come AFTER the task + quiz.
      order.push('page-ct');
      if (hasAiUse) order.push('page-ai-evaluation'); // CT with AI
    }

    order.push('page-debrief', 'page-submitted');
    return order;
  }

  // Visible section numbers, keyed by the secnum-* element suffix (underscores
  // here map to hyphens in the DOM id: ai_use_gate -> secnum-ai-use-gate).
  // The AI-use gate and the AI-experience page deliberately SHARE a number
  // (AI-experience is a sub-part of the AI-use section) — the existing
  // convention, preserved here.
  function computeSectionNumbers(placement, hasAiUse) {
    const pre = placement === 'pre';
    if (pre) {
      return hasAiUse
        ? { about_you: 1, srl: 2, ct: 3, ai_use_gate: 4, ai_experience: 4, ai_evaluation: 5, task: 6, quiz: 7, debrief: 8 }
        : { about_you: 1, srl: 2, ct: 3, ai_use_gate: 4, task: 5, quiz: 6, debrief: 7 };
    }
    return hasAiUse
      ? { about_you: 1, srl: 2, ai_use_gate: 3, ai_experience: 3, task: 4, quiz: 5, ct: 6, ai_evaluation: 7, debrief: 8 }
      : { about_you: 1, srl: 2, ai_use_gate: 3, task: 4, quiz: 5, ct: 6, debrief: 7 };
  }

  return {
    computePageOrder: computePageOrder,
    computeSectionNumbers: computeSectionNumbers
  };
});
