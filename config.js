export const config = {
  /**
   * Defines the folders to scan on the FTP/SFTP server.
   * Each object in the array represents a folder to process.
   */
  folders: [
    {
      path: '/charts',
      mediaType: '68e2cec48e063f6b17d4cf25',
      playlist: '68e2cee54bd8925ed120c1e6'
    },
    {
      path: '/dance',
      mediaType: '68e2cec48e063f6b17d4cf25',
      playlist: '68e2ceff3f32a98f262c7d6e'
    }
  ],

  /**
   * List of supported audio file extensions.
   * The script will only process files with these extensions.
   */
  supportedExtensions: ['.mp3', '.wav', '.flac', '.m4a', '.ogg'],

  /**
   * Performance settings.
   * concurrency: How many files to process and upload in parallel.
   * Increase this based on your server's CPU and network capacity.
   * A good starting point is between 5 and 15.
   */
  performance: {
    concurrency: 10
  },

  /**
   * Deduplication strategy.
   * We use a hash (a unique signature) of the file content to identify duplicates.
   * 'sha256' is very reliable. 'md5' is faster but slightly less collision-resistant.
   */
  hashingAlgorithm: 'sha256',

  /**
   * Display settings for the interactive console UI.
   */
  display: {
    // The maximum number of individual file tasks to display at once.
    // Set this to a number that comfortably fits your terminal height.
    maxVisibleTasks: 8
  }
}
