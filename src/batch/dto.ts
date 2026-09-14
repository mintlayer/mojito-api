import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class BatchDataDto {
  /** Endpoint template, e.g. `/address/:address` */
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  type: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  ids: string[];

  /** 0 = mainnet (default), 1 = testnet */
  @IsOptional()
  @IsNumber()
  @IsIn([0, 1])
  network?: number;
}

export class AddressesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  addresses: string[];

  @IsOptional()
  @IsNumber()
  @IsIn([0, 1])
  network?: number;
}
