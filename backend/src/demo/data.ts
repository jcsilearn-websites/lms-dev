// The words of the demo college. Everything here is invented: the college, the people and their addresses (`.example` is
// reserved and can never receive mail).

export const COLLEGE = {
  name: 'Nilgiri College of Engineering (Demo)',
  primaryColor: '#0f5c4d',
};

export const ADMIN = { local: 'principal', name: 'Dr. Meena Raghavan' };
export const INSTRUCTORS = [
  { local: 'arjun.nair', name: 'Prof. Arjun Nair' },
  { local: 'farida.sheikh', name: 'Dr. Farida Sheikh' },
];
export const ASSISTANT = { local: 'karthik.iyer', name: 'Karthik Iyer' };

/** The first one is the learner the walkthrough signs in as. */
export const LEARNER_NAMES = [
  'Ananya Krishnan',
  'Aditya Menon',
  'Bhavana Reddy',
  'Charan Kumar',
  'Deepika Subramanian',
  'Farhan Ali',
  'Gayathri Pillai',
  'Harish Venkatesh',
  'Ishita Banerjee',
  'Jeevan Prakash',
  'Kavya Shetty',
  'Lokesh Murugan',
  'Madhumitha Raja',
  'Naveen Joseph',
  'Oviya Selvam',
  'Pranav Deshpande',
  'Rithika Sundar',
  'Sanjana Rao',
  'Tarun Bhat',
  'Uma Maheswari',
  'Varun Chandran',
  'Yamini Gopal',
  'Zoya Khan',
  'Abhishek Verma',
  'Divya Natarajan',
  'Gokul Anand',
  'Meghana Hegde',
  'Nikhil Sharma',
  'Priyanka Das',
  'Siddharth Iyengar',
];

export const localPart = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, '.');

export interface DemoQuestion {
  stem: string;
  /** the first option is the right one */
  options: [string, string, string, string];
}

export interface DemoCourse {
  code: string;
  title: string;
  credits: number;
  instructor: number;
  withAssistant: boolean;
  modules: {
    title: string;
    readings: { title: string; paragraphs: string[] }[];
    lecture?: string;
    link?: { title: string; url: string };
  }[];
  questions: DemoQuestion[];
}

export const COURSES: DemoCourse[] = [
  {
    code: 'CS201',
    title: 'Data Structures',
    credits: 4,
    instructor: 0,
    withAssistant: true,
    modules: [
      {
        title: 'Unit 1: Arrays and linked lists',
        lecture: 'Lecture 1: Arrays and linked lists',
        readings: [
          {
            title: 'Why the choice of structure matters',
            paragraphs: [
              'An array keeps its elements next to each other, so reading the element at a given index takes constant time.',
              'Inserting in the middle of an array means moving every later element. A linked list changes two references instead.',
            ],
          },
          {
            title: 'Worked example: reversing a linked list',
            paragraphs: [
              'Walk the list once, keeping the previous node, the current node and the next node.',
              'Point the current node back at the previous one, then move all three forward.',
            ],
          },
        ],
        link: { title: 'Visualising linked lists', url: 'https://visualgo.net/en/list' },
      },
      {
        title: 'Unit 2: Stacks and queues',
        lecture: 'Lecture 2: Stacks and queues',
        readings: [
          {
            title: 'Stacks in everyday programs',
            paragraphs: [
              'A stack returns the item added last. Function calls, undo and bracket matching all use one.',
            ],
          },
          {
            title: 'Circular queues',
            paragraphs: [
              'A circular queue reuses the space freed at the front by wrapping the index around with a remainder.',
            ],
          },
        ],
      },
      {
        title: 'Unit 3: Trees',
        readings: [
          {
            title: 'Binary search trees',
            paragraphs: [
              'Every key in the left subtree is smaller than the node and every key in the right subtree is larger.',
              'The cost of a search is the height of the tree, which is why balance matters.',
            ],
          },
        ],
      },
    ],
    questions: [
      {
        stem: 'Which operation on an array takes constant time?',
        options: [
          'Reading the element at a known index',
          'Inserting at the front',
          'Searching an unsorted array',
          'Deleting from the middle',
        ],
      },
      {
        stem: 'Which structure returns items in the order last in, first out?',
        options: ['Stack', 'Queue', 'Binary tree', 'Hash table'],
      },
      {
        stem: 'What does a singly linked list node hold?',
        options: [
          'A value and a reference to the next node',
          'Two values',
          'Only a reference',
          'An index and a value',
        ],
      },
      {
        stem: 'Which traversal of a binary search tree visits keys in ascending order?',
        options: ['In-order', 'Pre-order', 'Post-order', 'Level order'],
      },
      {
        stem: 'A queue is most naturally used for which task?',
        options: [
          'Serving requests in the order they arrive',
          'Undoing the last action',
          'Matching brackets',
          'Evaluating a postfix expression',
        ],
      },
      {
        stem: 'What is the worst-case height of an unbalanced binary search tree of n keys?',
        options: ['n - 1', 'log n', 'n / 2', '1'],
      },
      {
        stem: 'Why is inserting at the head of a linked list cheap?',
        options: [
          'Only one or two references change',
          'The list is sorted',
          'Memory is contiguous',
          'The list keeps an index',
        ],
      },
      {
        stem: 'Which structure is used to keep track of function calls?',
        options: ['Stack', 'Queue', 'Graph', 'Heap file'],
      },
    ],
  },
  {
    code: 'ME101',
    title: 'Engineering Mechanics',
    credits: 3,
    instructor: 1,
    withAssistant: false,
    modules: [
      {
        title: 'Unit 1: Forces and equilibrium',
        lecture: 'Lecture 1: Free body diagrams',
        readings: [
          {
            title: 'Drawing a free body diagram',
            paragraphs: [
              'Isolate the body, then draw every external force acting on it with its direction.',
              'A body in equilibrium has no resultant force and no resultant moment.',
            ],
          },
          {
            title: 'Resolving forces',
            paragraphs: ['Resolve each force along two perpendicular axes before adding them.'],
          },
        ],
      },
      {
        title: 'Unit 2: Friction',
        readings: [
          {
            title: 'Laws of dry friction',
            paragraphs: [
              'The limiting friction is proportional to the normal reaction and does not depend on the area of contact.',
            ],
          },
        ],
      },
    ],
    questions: [
      {
        stem: 'A body is in equilibrium when the resultant force and the resultant moment are',
        options: [
          'both zero',
          'equal to each other',
          'both positive',
          'perpendicular to the weight',
        ],
      },
      {
        stem: 'The SI unit of moment of a force is',
        options: ['newton metre', 'newton', 'joule per second', 'pascal'],
      },
      {
        stem: 'The limiting force of dry friction is proportional to',
        options: [
          'the normal reaction',
          'the area of contact',
          'the speed',
          'the volume of the body',
        ],
      },
      {
        stem: 'A couple consists of two forces that are',
        options: [
          'equal, opposite and not on the same line',
          'equal and in the same direction',
          'unequal and concurrent',
          'zero',
        ],
      },
      {
        stem: 'Varignon theorem relates the moment of a resultant to',
        options: [
          'the sum of the moments of its components',
          'the weight of the body',
          'the coefficient of friction',
          'the area under a curve',
        ],
      },
      {
        stem: 'The centroid of a triangle lies at what fraction of the height from the base?',
        options: ['one third', 'one half', 'two thirds', 'one quarter'],
      },
    ],
  },
];
