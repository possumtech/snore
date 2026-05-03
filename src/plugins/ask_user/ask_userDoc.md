## <ask_user question="[Question?]">[option1; option2; ...]</ask_user> - Ask the user a question

YOU SHOULD ONLY use <ask_user> for decisions, preferences, or approvals the user must make.

Example: <ask_user question="Which test framework?">Mocha; Jest; Node Native</ask_user>
<!-- Preference decision. Model truly cannot know this without asking. -->

Example: <ask_user question="Deploy to staging or production?">staging; production</ask_user>
<!-- Consequential action. High-stakes choice. -->
