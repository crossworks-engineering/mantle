# Made-up Microsoft Project samples

Test plans from MPXJ's own test data (`junit/data` of
https://github.com/joniles/mpxj at tag v16.11.0, commit
748796d78b689712911c62535947ad970cf20ac0), under MPXJ's licence, the GNU
LGPL 2.1 or later. They are made-up schedules for testing, not anyone's
work. Renamed only; the bytes are as published.

| File              | From (under junit/data)                                                       | Project format                                | Tasks | Resources | Assignments |
| ----------------- | ----------------------------------------------------------------------------- | --------------------------------------------- | ----- | --------- | ----------- |
| plan-mpp8.mpp     | assignment/assignment-deletion/assigned-resources-mpp8-project2003.mpp        | MPP8 (Project 98)                             | 1     | 10        | 10          |
| plan-mpp9.mpp     | generated/assignment-assignments/assignment-assignments-project2000-mpp9.mpp  | MPP9 (Project 2000 to 2003)                   | 4     | 3         | 4           |
| plan-mpp12.mpp    | generated/assignment-assignments/assignment-assignments-project2007-mpp12.mpp | MPP12 (Project 2007)                          | 4     | 4         | 4           |
| plan-mpp14.mpp    | generated/assignment-assignments/assignment-assignments-project2019-mpp14.mpp | MPP14 (Project 2010 and later, saved by 2019) | 4     | 4         | 4           |
| password-mpp9.mpp | password-protected-mpp9.mpp                                                   | MPP9, a read password set                     | -     | -         | -           |

The counts are the MSPDI elements the converter writes (a project's
summary task, and Project's unnamed resource, count where Project wrote
them). Used by the parser image build (the Dockerfile's
mpxj-build stage: the trace of what MPXJ looks up, then a check of every
sample) and by the tests (packages/content/src/pipeline-runner.test.ts, "a native
Project file", when PARSER_MPP names the converter). Never put a real
plan here.
